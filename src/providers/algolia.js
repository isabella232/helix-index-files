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

/* eslint-disable no-param-reassign */

'use strict';

const p = require('path');
const algoliasearch = require('algoliasearch');

const mapResult = require('./mapResult.js');

/**
 * Return an array consisting of all parents of a path.
 *
 * @param {string} filename filename
 * @returns array of parents
 */
function makeparents(path) {
  const parent = p.dirname(path);
  if (parent === '/' || parent === '.' || !parent) {
    return ['/'];
  }
  return [...makeparents(parent), parent];
}

/**
 * Algolia index provider.
 */
class Algolia {
  constructor(params, config, log) {
    const {
      ALGOLIA_APP_ID: appID,
      ALGOLIA_API_KEY: apiKey,
    } = params;

    if (!appID) {
      throw new Error('ALGOLIA_APP_ID parameter missing.');
    }
    if (!apiKey) {
      throw new Error('ALGOLIA_API_KEY parameter missing.');
    }
    const algolia = algoliasearch(appID, apiKey);

    const {
      owner, repo, branch,
    } = params;

    this._indexName = `${owner}--${repo}--${config.name}`;
    this._index = algolia.initIndex(this._indexName);
    this._branch = branch;
    this._config = config;
    this._log = log;
  }

  async _search(attributes) {
    const filters = Object.getOwnPropertyNames(attributes)
      .filter(
        (name) => attributes[name],
      )
      .map(
        (name) => `${name}:${attributes[name]}`,
      );
    const searchresult = await this._index.search('', {
      attributesToRetrieve: ['path', 'name', 'objectID', 'sourceHash'],
      filters: filters.join(' AND '),
    });
    if (searchresult.nbHits !== 0) {
      const record = searchresult.hits[0];
      return {
        id: record.objectID,
        ...record,
      };
    }
    return null;
  }

  async update(record) {
    const { path, sourceHash } = record;
    if (!sourceHash) {
      const message = `Unable to update ${path}: sourceHash is empty.`;
      this.log.warn(message);
      return mapResult.error(path, message);
    }

    const base = {
      objectID: `${this._branch}--${path}`,
      branch: this._branch,
      creationDate: new Date().getTime(),
      name: p.basename(path),
      parents: makeparents(`/${path}`),
      dir: p.dirname(path),
    };
    const object = { ...base, ...record };

    // Delete a stale copy at another location
    let oldLocation;
    const hit = await this._search({ branch: this._branch, sourceHash });
    if (hit && hit.path !== path) {
      oldLocation = hit.path;
      await this._index.deleteObject(hit.objectID);
      this.log.info(`Deleted record in '${this._indexName}' for resource moved from: ${hit.path}`);
    }

    // Add record to index
    const result = await this._index.saveObject(object);
    this.log.info(`Saved record in '${this._indexName}' for resource at: ${path}`);

    return oldLocation
      ? mapResult.moved(path, oldLocation, result)
      : mapResult.created(path, result);
  }

  async delete(attributes) {
    const hit = await this._search({ branch: this._branch, ...attributes });
    if (hit) {
      this.log.info(`Deleting index record for resource at: ${hit.path}`);
      await this._index.deleteObject(hit.objectID);
      return mapResult.notFound({ path: hit.path }, true);
    }
    return mapResult.notFound(attributes, false);
  }

  get log() {
    return this._log;
  }
}

module.exports = {
  name: 'Algolia',
  required: ['ALGOLIA_APP_ID', 'ALGOLIA_API_KEY'],
  match: (url) => !url,
  create: (params, config, log) => new Algolia(params, config, log),
};
