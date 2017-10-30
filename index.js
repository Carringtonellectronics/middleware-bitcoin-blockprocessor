const bcoin = require('bcoin'),
  filterAccountsService = require('./services/filterAccountsService'),
  ipcService = require('./services/ipcService'),
  mongoose = require('mongoose'),
  amqp = require('amqplib'),
  memwatch = require('memwatch-next'),
  bunyan = require('bunyan'),
  TX = require('bcoin/lib/primitives/tx'),
  customNetworkRegistrator = require('./networks'),
  log = bunyan.createLogger({name: 'core.blockProcessor'}),
  config = require('./config');

/**
 * @module entry point
 * @description process blocks, and notify, through rabbitmq, other
 * services about new block or tx, where we meet registered address
 */

customNetworkRegistrator(config.bitcoin.network);

const node = new bcoin.fullnode({
  network: config.bitcoin.network,
  db: config.bitcoin.db,
  prefix: config.bitcoin.dbpath,
  spv: true,
  indexTX: true,
  indexAddress: true,
  'log-level': 'error',
  'coinbase-address': config.bitcoin.coinbase
});

mongoose.Promise = Promise;
mongoose.connect(config.mongo.uri, {useMongoClient: true});

mongoose.connection.on('disconnected', function () {
  log.error('mongo disconnected!');
  process.exit(0);
});

const init = async function () {
  let amqpConn = await amqp.connect(config.rabbit.url)
    .catch(() => {
      log.error('rabbitmq is not available!');
      process.exit(0);
    });

  let channel = await amqpConn.createChannel();

  channel.on('close', () => {
    log.error('rabbitmq process has finished!');
    process.exit(0);
  });

  try {
    await channel.assertExchange('events', 'topic', {durable: false});
  } catch (e) {
    log.error(e);
    channel = await amqpConn.createChannel();
  }

  await node.open();
  await node.connect();

  memwatch.on('leak', () => {
    log.info('leak');

    if (!node.pool.syncing) {
      return;
    }

    try {
      node.stopSync();
    } catch (e) {
    }

    setTimeout(() => node.startSync(), 60000);
  });

  node.on('connect', async (entry, block) => {
    log.info('%s (%d) added to chain.', entry.rhash(), entry.height);
    await channel.publish('events', `${config.rabbit.serviceName}_block`, new Buffer(JSON.stringify({block: entry.height})));
    let filtered = await filterAccountsService(block);

    await Promise.all(filtered.map(item =>
      channel.publish('events', `${config.rabbit.serviceName}_transaction.${item.address}`, new Buffer(JSON.stringify(Object.assign(item, {block: entry.height}))))
    ));

  });

  node.on('pushed_tx', async (tx) => { //custom event, which fires on tx push via rest module
    let filtered = await filterAccountsService({txs: [TX.fromRaw(tx, 'hex')]});
    await Promise.all(filtered.map(item =>
      channel.publish('events', `${config.rabbit.serviceName}_transaction.${item.address}`, new Buffer(JSON.stringify(Object.assign(item, {block: -1}))))
    ));
  });

  ipcService(node);
  node.startSync();
};

module.exports = init();
