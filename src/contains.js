/*
 * Copyright 2020 Adobe. All rights reserved.
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

const mm = require('micromatch');

/**
 * Return a flag indicating whether a particular path is contained
 * in the indexing configuration (include or exclude element).
 *
 * @param {Array} cfg indexing configuration's
 * @param {string} path path to check
 * @param {boolean} ifmissing what to return if section is missing
 *
 * @returns {Boolean} whether path is included in configuration
 */
function match(cfg, path, ifmissing) {
  if (!cfg) {
    // no section means no match
    return ifmissing;
  }
  if (cfg.length === 0) {
    // empty list means no match
    return false;
  }
  return mm.isMatch(path, cfg
    // expand braces in every item (creates an array of arrays)
    .map((i) => mm.braces((i)))
    // flatten to a simple array of strings
    .reduce((a, i) => {
      a.push(...i);
      return a;
    }, []));
}

/**
 * Return a flag indicating whether a particular path is contained
 * in the indexing configuration (include or exclude element). This
 * is true if a path is included and *not* excluded.
 *
 * @param {Array} cfg indexing configuration's
 * @param {string} path path to check
 *
 * @returns {Boolean} whether path is included in configuration
 */
function contains(cfg, path) {
  return match(cfg.include, path, true) && !match(cfg.exclude, path, false);
}

module.exports = contains;
