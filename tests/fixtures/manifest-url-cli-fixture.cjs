'use strict';

const { main } = require('../../cli/index');

const argumentsList = process.argv.slice(2);
const manifestIndex = argumentsList.indexOf('--manifest');
const remote = manifestIndex === -1 ? '' : argumentsList[manifestIndex + 1];

global.fetch = async () => {
  throw new Error(`transport echoed ${remote}`);
};

(async () => {
  await main(argumentsList);
})();
