/*
 * Copyright 2019 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

'use strict';

const flatten = require('lodash.flatten');
const { logger } = require('@adobe/openwhisk-action-logger');
const { wrap } = require('@adobe/openwhisk-action-utils');
const statusWrap = require('@adobe/helix-status').wrap;

const Change = require('./Change.js');
const fetchQuery = require('./fetch-query.js');
const contains = require('./contains.js');
const indexPipelines = require('./index-pipelines.js');

const algolia = require('./providers/algolia.js');
const azure = require('./providers/azure.js');
const excel = require('./providers/excel.js');

/**
 * List of known index providers.
 */
const providers = [
  algolia, azure, excel,
];

/**
 * Return a flag indicating whether a list of required parameters is
 * available in the list of actual parameters.
 *
 * @param {Array} required required parameters
 * @param {Array} actual provided paramaters
 */
function hasParams(required, actual) {
  const provided = required.filter((parameter) => actual[parameter] !== undefined);
  return provided.length === required.length;
}

/**
 * Create providers along index definitions and return an array of objects
 * consisting of an index definition and its providers
 *
 * @param {Array} indices array of index definitions
 * @returns array of index definitions and their providers
 */
function createProviders(indices, params, log) {
  return indices
    .map((config) => {
      let provider;
      const candidate = providers
        .filter((c) => hasParams(c.required, params))
        .find((c) => c.match(config.target));
      if (candidate) {
        try {
          provider = candidate.create(params, config, log);
        } catch (e) {
          log.error(`Unable to create provider for ${config.name}`, e);
        }
      }
      return { config, provider };
    });
}

/**
 * Return a change object with path, uid and type
 *
 * @param {object} params Runtime parameters
 * @returns change object
 */
function getChange(params) {
  const { observation } = params;
  if (observation) {
    const { change, mountpoint } = observation;
    const opts = { uid: change.uid, path: change.path, type: change.type };
    if (mountpoint && opts.path) {
      const re = new RegExp(`^${mountpoint.root}/`);
      const repl = mountpoint.path.replace(/^\/+/, '');
      opts.path = opts.path.replace(re, repl);
    }
    return new Change(opts);
  }
  if (!params.path) {
    throw new Error('path parameter missing.');
  }
  return new Change({ path: params.path });
}

/**
 * Handle deletion of an item for all index providers.
 *
 * @param {object} param0 parameters
 * @param {Change} change change containing deletion
 * @param {object} log logger
 */
async function handleDelete({ config, provider }, change, log) {
  if (!provider) {
    return {
      status: 400,
      reason: 'Provider not available, parameters missing or target unsuitable',
    };
  }
  try {
    return await provider.delete({ sourceHash: change.uid });
  } catch (e) {
    log.error(`An error occurred deleting record ${change.uid} in ${config.name}`, e);
    return {
      status: 500,
      reason: e.message,
    };
  }
}

/**
 * Handle a single update for an index provider.
 *
 * @param {object} param0 parameters
 * @param {Change} change change
 * @param {object} log logger
 */
async function handleUpdate({
  config, provider, path, body,
}, change, log) {
  if (!provider) {
    return {
      status: 400,
      reason: 'Provider not available, parameters missing or target unsuitable',
    };
  }
  if (!path) {
    return {
      status: 404,
      reason: `Item path not in index definition: ${change.path}`,
    };
  }
  const { error } = body;
  if (error && error.status !== 404) {
    return error;
  }
  try {
    const doc = body.docs ? body.docs[0] : null;
    return doc
      ? await provider.update({ path, ...doc })
      : await provider.delete({ path });
  } catch (e) {
    log.error(`An error occurred updating record ${path} in ${config.name}`, e);
    return {
      status: 500,
      reason: e.message,
    };
  }
}

/**
 * Replace an extension in a path. If the path has no extension,
 * nothing is replaced.
 *
 * @param {string} path path
 * @param {string} ext extension
 */
function replaceExt(path, ext) {
  const dot = path.lastIndexOf('.');
  if (dot > path.lastIndexOf('/')) {
    return `${path.substr(0, dot)}.${ext}`;
  }
  return path;
}

/**
 * Invoke index-pipelines action for all indices.
 *
 * @param {string} pkgPrefix prefix of the package we reside in
 * @param {object} indices index configurations
 * @param {object} change change to process
 * @param {object} params parameters
 * @param {object} log OW logger
 *
 * @returns object containing index definition and index record, keyed by name
 */
async function runPipeline(pkgPrefix, indices, change, params, log) {
  // Create our result where we'll store the HTML responses
  const records = indices
    .reduce((prev, { config, provider }) => {
      // eslint-disable-next-line no-param-reassign
      prev[config.name] = {
        config,
        provider,
        path: provider && contains(config, change.path)
          ? replaceExt(change.path, config.source)
          : null,
      };
      return prev;
    }, {});

  // Create a unique set of the paths found
  const paths = Array.from(Object.values(records)
    .filter(({ path }) => path)
    .reduce((prev, { path }) => {
      prev.add(path);
      return prev;
    }, new Set()));

  // Invoke the pipelines action
  const responses = new Map(await Promise.all(paths.map(async (path) => {
    const body = await indexPipelines(pkgPrefix, params, path);
    return [path, body];
  })));

  // Finish by filling in all responses acquired
  Object.values(records).filter(({ path }) => path).forEach((record) => {
    const response = responses.get(record.path);
    const body = response[record.config.name];
    if (!body) {
      log.info(`Pipeline did not return entry for index: ${record.config.name}, path: ${record.path}`);
    } else {
      // eslint-disable-next-line no-param-reassign
      record.body = body;
    }
  });
  return Object.values(records);
}

/**
 * Runtime action.
 *
 * @param {object} params parameters
 */
async function run(params) {
  const {
    owner, repo, ref, __ow_logger: log,
  } = params;

  if (!owner) {
    throw new Error('owner parameter missing.');
  }
  if (!repo) {
    throw new Error('repo parameter missing.');
  }
  if (!ref) {
    throw new Error('ref parameter missing.');
  }

  const {
    __OW_ACTION_NAME: actionName,
  } = process.env;

  const pkgPrefix = actionName ? `${actionName.split('/')[2]}/` : '';

  const change = getChange(params);
  const config = await fetchQuery({ owner, repo, ref }, { timeout: 1000 });
  const indices = createProviders(config.indices, params, log);

  let responses;
  if (change.deleted) {
    responses = await Promise.all(indices.map(async (index) => ({
      [index.config.name]: await handleDelete(index, change, log),
    })));
  } else {
    const records = await runPipeline(pkgPrefix, indices, change, params, log);
    responses = await Promise.all(records.map(async (record) => ({
      [record.config.name]: await handleUpdate(record, change, log),
    })));
  }
  const results = flatten(responses);
  return { statusCode: 207, body: { results } };
}

/**
 * Fill a missing branch in the parameters.
 *
 * @param {function} func function to wrap
 */
function fillBranch(func) {
  return (params) => {
    if (params && params.ref && !params.branch) {
      const { ref } = params;
      if (ref.length === 40 && /^[a-f0-9]+$/.test(ref)) {
        throw new Error(`branch parameter missing and ref looks like a commit id: ${ref}`);
      } else {
        // eslint-disable-next-line no-param-reassign
        params.branch = params.ref;
      }
    }
    return func(params);
  };
}

module.exports.main = wrap(run)
  .with(logger)
  .with(statusWrap)
  .with(fillBranch);
