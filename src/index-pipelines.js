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

const ow = require('openwhisk');
const OpenWhiskError = require('openwhisk/lib/openwhisk_error');

/**
 * Fetch documents that will be added to our index.
 *
 * @param {string} pkgPrefix package name to prepend action name with
 * @param {Object} params parameters
 * @param {string} path path to fetch documents for
 * @returns document array
 */
async function run(pkgPrefix, params, path) {
  const {
    version = 'latest',
    owner, repo, ref, __ow_logger: log,
  } = params;
  const action = `${pkgPrefix}index-pipelines@${version}`;

  log.info(`Invoking ${action} for path: ${path}`);
  const { activationId, response: { result } } = await ow().actions.invoke({
    name: `${action}`,
    blocking: true,
    params: {
      owner, repo, ref, path,
    },
  });

  if (!result.body) {
    const message = `${action} (activation id: ${activationId}) returned no body`;
    throw new OpenWhiskError(message, null, 500);
  }
  return result.body;
}

module.exports = run;
