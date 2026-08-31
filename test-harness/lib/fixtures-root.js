'use strict';

/**
 * Single shared root every test-harness script writes its generated scratch data under - fixture trees, .iso
 * files, manifests, failure screenshots, error logs, everything. Nothing test-related is ever written to the OS
 * temp directory, AppData, or the app's own real temp/cache directory (appData/config.json's
 * cacheDataDirectoryPath - reserved for the real app's own live split scratch files, see
 * generate-tree-from-json.js's own top comment for why that one's specifically off-limits too). One place to
 * look, one place to delete by hand if anything needs cleaning up.
 *
 * Every script that used to build its own scratch root under os.tmpdir() (`path.join(os.tmpdir(),
 * 'optical-backup-test-fixtures', ...)`) now builds it under FIXTURES_ROOT instead, keeping the exact same
 * per-run subfolder naming - only the base moved.
 */

const path = require('path');

const FIXTURES_ROOT = path.resolve(__dirname, '..', 'generated-fixtures');

module.exports = { FIXTURES_ROOT };
