/**
 * Copyright 2017–2018, LaborX PTY
 * Licensed under the AGPL Version 3 license.
 * @author Egor Zuev <zyev.egor@gmail.com>
 */

const _ = require('lodash'),
  config = require('../config'),
  bunyan = require('bunyan'),
  Promise = require('bluebird'),
  exec = require('../services/execService'),
  log = bunyan.createLogger({name: 'app.utils.allocateBlockBuckets'}),
  blockModel = require('../models/blockModel');

module.exports = async function () {

  const currentBlock = await blockModel.findOne({}, {number: 1}, {sort: {number: -1}});
  const currentCacheHeight = _.get(currentBlock, 'number', -1);

  let blockNumbers = [];
  for (let i = 0; i < currentCacheHeight; i++)
    blockNumbers.push(i);

  const blockNumberChunks = _.chunk(blockNumbers, 10000);
  let missedBuckets = [];
  const missedBlocks = [];

  for (let blockNumberChunk of blockNumberChunks) {
    log.info(`validating blocks from: ${_.head(blockNumberChunk)} to ${_.last(blockNumberChunk)}`);
    const count = await blockModel.count({number: {$in: blockNumberChunk}});
    if (count !== blockNumberChunk.length && count)
      missedBuckets.push(blockNumberChunk);
    if (!count)
      for (let blockNumber of blockNumberChunk)
        missedBlocks.push(blockNumber);
  }

  for (let missedBucket of missedBuckets)
    if (missedBucket.length)
      for (let blockNumber of missedBucket) {
        log.info(`validating block: ${blockNumber}`);
        const isExist = await blockModel.count({number: blockNumber});
        if (!isExist)
          missedBlocks.push(blockNumber);
      }

  let currentNodeHeight = await Promise.resolve(exec('getblockcount', [])).timeout(10000).catch(() => -1);

  for (let i = currentCacheHeight + 1; i < currentNodeHeight - config.consensus.lastBlocksValidateAmount; i++)
    missedBlocks.push(i);

  missedBuckets = _.chain(missedBlocks).sortBy().reverse().uniq().filter(number=> number < currentNodeHeight - config.consensus.lastBlocksValidateAmount).chunk(10000).value();

  if (currentNodeHeight === -1)
    return Promise.reject({code: 0});

  return {missedBuckets: missedBuckets, height: currentNodeHeight - config.consensus.lastBlocksValidateAmount < 0 ? 0 : currentNodeHeight - config.consensus.lastBlocksValidateAmount };

};
