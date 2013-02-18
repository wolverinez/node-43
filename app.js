// Load global configuration
var config = require('./config');

// Load deps
var zmq = require('zmq'),
    zlib = require('zlib'),
    colors = require('colors'),
    zmqSocket = zmq.socket('sub'),
    pg = require('pg'),
    Stats = require('fast-stats').Stats,
    emds = require('./emds');

// Global stat variables
var messagesTotal = 0;
var messagesOrders = 0;
var orderUpserts = 0;
var historyUpserts = 0;

// Backlog counters
var stdDevWaiting = 0;
var upsertWaiting = 0;
var statWaiting = 0;
var historyWaiting = 0;

// EMDR statistics variables
var emdrStatsEmptyOrderMessages = 0;
var emdrStatsOrderInserts = 0;
var emdrStatsOrderUpdates = 0;
var emdrStatsHistoryMessages = 0;
var emdrStatsOrderMessages = 0;
var emdrStatsHistoryUpdates = 0;

// Connect to database
var pgClient = new pg.Client(config.postgresConnectionString);
process.stdout.write('Connecting to PostgreSQL server: ');
pgClient.connect();
console.log('OK!'.green);

// Connect to the relays specified in the config file
for(var relay in config.relays) {
    process.stdout.write('Connecting to ' + config.relays[relay].underline + ':');

    // Connect to the relay.
    zmqSocket.connect(config.relays[relay]);

    console.log(' OK!'.green);
}

// Disable filtering
zmqSocket.subscribe('');

// Message Handling
zmqSocket.on('error', function(error) {
    console.log('ERROR: ' + error);
});

// EMDR Message handling begins here
zmqSocket.on('message', function(message) {
    // Receive raw market JSON strings.
    zlib.inflate(message, function(error, marketJSON) {

        // Parse the JSON data.
        var marketData = JSON.parse(marketJSON);

        // Increase stat counter
        messagesTotal++;

        if(marketData.resultType == 'orders') {
            // Increase stat counters
            messagesOrders++;
            emdrStatsOrderMessages++;

            // Extract objects from message
            orders = emds.getOrderObjects(marketData);

            // Get region/type pairs - we need them to minimize the amount of queries needed for the std. deviations
            regionTypes = emds.getDistinctRegionTypePairs(marketData);

            // Iterate over regions affected
            if(orders.length > 0) {
                for(var regionID in regionTypes) {

                    // Iterate over types affected in that region
                    for(i = 0; i < regionTypes[regionID].length; i++) {

                        var typeID = regionTypes[regionID][i];

                        // Write that combination to DB
                        upsertOrders(orders, typeID, regionID);
                    }
                }
            } else {
                // Increase stat value
                emdrStatsEmptyOrderMessages++;
            }
        } else if(marketData.resultType == 'history') {
            var historyObjects = emds.getHistoryObjects(marketData);

            if(historyObjects.length > 0) {
                // Collect all the data in the right order
                var params = [];
                var values = '';

                for(x = 0; x < historyObjects.length; x++) {
                    var o = historyObjects[x];

                    // Add to values string
                    values += '(' + o.regionID + ',' + o.typeID + ',' + o.orders + ',' + o.low + ',' + o.high + ',' + o.average + ',' + o.quantity + ', \'' + o.date + '\'::timestamp AT TIME ZONE \'UTC\'),';
                }

                values = values.slice(0, -1);

                // Execute query
                pgClient.query('WITH new_values (mapregion_id, invtype_id, numorders, low, high, mean, quantity, date) AS (VALUES ' + values + '), upsert as (UPDATE market_data_orderhistory o SET numorders = new_value.numorders, low = new_value.low, high = new_value.high, mean = new_value.mean, quantity = new_value.quantity FROM new_values new_value WHERE o.mapregion_id = new_value.mapregion_id AND o.invtype_id = new_value.invtype_id AND o.date = new_value.date AND o.date >= NOW() - \'1 day\'::INTERVAL RETURNING o.*) INSERT INTO market_data_orderhistory (mapregion_id, invtype_id, numorders, low, high, mean, quantity, date) SELECT mapregion_id, invtype_id, numorders, low, high, mean, quantity, date FROM new_values WHERE NOT EXISTS (SELECT 1 FROM upsert up WHERE up.mapregion_id = new_values.mapregion_id AND up.invtype_id = new_values.invtype_id AND up.date = new_values.date) AND NOT EXISTS (SELECT 1 FROM market_data_orderhistory WHERE mapregion_id = new_values.mapregion_id AND invtype_id = new_values.invtype_id AND date = new_values.date)', function(err, result) {
                    if(err) {
                        console.log('History upsert error:');
                        console.log(err);
                        if(config.extensiveLogging) console.log(values);
                    } else {
                        // Increase stat counters
                        historyUpserts += historyObjects.length;
                        emdrStatsHistoryMessages++;
                        emdrStatsHistoryUpdates = historyObjects.length.length - result.rowCount;
                    }
                });
            }
        }
    });
});

// Upsert orders

function upsertOrders(orders, typeID, regionID) {
    // Get all the statistical data for the isSuspicios flag:
    // Check order if "supicious" which is an arbitrary definition.  Any orders that are outside config.stdDevRejectionMultiplier standard deviations
    // of the mean AND where there are more than 5 orders of like type in the region will be flagged.
    // Flags: True = Yes (suspicious), False = No (not suspicious)
    //
    // Execute query asynchnously

    stdDevWaiting++;

    // Use a prepared statement for performance reasons
    pgClient.query({
        name: 'upsert_orders_stddev',
        text: 'SELECT COUNT(id), STDDEV(price), AVG(price) FROM market_data_orders WHERE invtype_id=$1 AND mapregion_id=$2 AND is_active=\'t\' AND is_suspicious=\'f\'',
        values: [typeID, regionID]
    }, function(err, result) {

        stdDevWaiting--;

        if(err) {
            console.log('SQL error while determining standard deviation:');
            console.log(err);
            if(config.extensiveLogging) console.log(typeID);
        } else {
            // Iterate over orders and select those orders which are affected
            var ordersToUpsert = [];
            var hasSuspiciousOrders = false;

            for(c = 0; c < orders.length; c++) {
                if(orders[c].typeID == typeID && orders[c].regionID == regionID) {
                    // Add the flag to the order
                    // First, check if we have more than 5 orders present
                    if(result.rows[0].count > 5) {
                        // See if the price is right or left of the mean value
                        if(orders[c].price > result.rows[0].avg) {

                            // If the distance between mean and price is greater than config.stdDevRejectionMultiplier * σ this must be a suspicious order
                            if(((orders[c].price - result.rows[0].avg) > (config.stdDevRejectionMultiplier  * result.rows[0].stddev)) && orders[c].bid) {
                                orders[c].isSuspicious = true;
                                hasSuspiciousOrders = true;
                            } else {
                                orders[c].isSuspicious = false;
                            }

                        } else {

                            // If the distance between mean and price is greater than config.stdDevRejectionMultiplier * σ this must be a suspicious order
                            if(((result.rows[0].avg - orders[c].price) > (config.stdDevRejectionMultiplier  * result.rows[0].stddev)) && !orders[c].bid) {
                                orders[c].isSuspicious = true;
                                hasSuspiciousOrders = true;
                            } else {
                                orders[c].isSuspicious = false;
                            }

                        }
                    } else {
                        // Not enough datapoints for a reliable guess
                        orders[c].isSuspicious = false;
                    }
                    // Finally, push that order to list
                    ordersToUpsert.push(orders[c]);
                }
            }

            if(ordersToUpsert.length > 0) {
                var values = '';

                // Upsert this chunk
                // Generate query strings
                for(x = 0; x < ordersToUpsert.length; x++) {
                    // Generate parameter list
                    var o = ordersToUpsert[x];
                    values += '(\'' + o.generatedAt + '\'::timestamp AT TIME ZONE \'UTC\',' + o.price + ',' + o.volRemaining + ',' + o.volEntered + ',' + o.minVolume + ',' + o.range + ',' + o.orderID + ',' + o.bid + ',\'' + o.issueDate + '\'::timestamp AT TIME ZONE \'UTC\',' + o.duration + ',' + o.isSuspicious + ',\'\',\'' + o.ipHash + '\',' + o.regionID + ',' + o.typeID + ',' + o.stationID + ',' + o.solarSystemID + ',true),';
                }

                // Cut off trailing comma
                values = values.substring(0, values.length - 1);

                // Prepare query
                var upsertQuery = "WITH new_values (generated_at, price, volume_remaining, volume_entered, minimum_volume, order_range, id, is_bid, issue_date, duration, is_suspicious, message_key, uploader_ip_hash, mapregion_id, invtype_id, stastation_id, mapsolarsystem_id, is_active) AS (values " + values + "), upsert as ( UPDATE market_data_orders o SET price = new_value.price, volume_remaining = new_value.volume_remaining, generated_at = new_value.generated_at, issue_date = new_value.issue_date, is_suspicious = new_value.is_suspicious, uploader_ip_hash = new_value.uploader_ip_hash, is_active = 't' FROM new_values new_value WHERE o.id = new_value.id AND o.generated_at < new_value.generated_at RETURNING o.* ) INSERT INTO market_data_orders (generated_at, price, volume_remaining, volume_entered, minimum_volume, order_range, id, is_bid, issue_date, duration, is_suspicious, message_key, uploader_ip_hash, mapregion_id, invtype_id, stastation_id, mapsolarsystem_id, is_active) SELECT generated_at, price, volume_remaining, volume_entered, minimum_volume, order_range, id, is_bid, issue_date, duration, is_suspicious, message_key, uploader_ip_hash, mapregion_id, invtype_id, stastation_id, mapsolarsystem_id, is_active FROM new_values WHERE NOT EXISTS (SELECT 1 FROM upsert up WHERE up.id = new_values.id) AND NOT EXISTS (SELECT 1 FROM market_data_orders WHERE id = new_values.id)";

                upsertWaiting++;

                // Execute query
                pgClient.query(upsertQuery, function(err, result) {
                    upsertWaiting--;
                    if(err) {
                        console.log('Order upsert error:');
                        console.log(err);
                        if(config.extensiveLogging) console.log(values);
                    } else {
                        // Increase stat counters
                        orderUpserts += ordersToUpsert.length;
                        emdrStatsOrderInserts += result.rowCount;
                        emdrStatsOrderUpdates += ordersToUpsert.length - result.rowCount;
                    }
                });

                // Re-calculate statistics
                generateRegionStats(regionID, typeID);

                // Deactivate expired orders, if we do not have any suspicious orders in that message
                if(!hasSuspiciousOrders) {
                    // Collect all order IDs
                    var ids = [];
                    for(x = 0; x < ordersToUpsert.length; x++) {
                        ids.push(ordersToUpsert[x].orderID);
                    }

                    // Generate placeholders
                    var placeholderIDs = ids.map(function(name, x) {
                        return '$' + (x + 3);
                    }).join(',');

                    // Generate flat params array
                    var params = [];
                    params.push(regionID, typeID);
                    params = params.concat(ids);

                    // Execute query
                    pgClient.query('UPDATE market_data_orders SET is_active = \'f\' WHERE mapregion_id=$1 AND invtype_id=$2 AND is_active=\'t\' AND market_data_orders.id NOT IN (' + placeholderIDs + ')', params, function(err, result) {
                        if(err) {
                            console.log('Order upsert error:');
                            console.log(err);
                            if(config.extensiveLogging) console.log(params);
                        } else {
                            // Dont't do anything for now
                        }
                    });
                }
            }
        }
    });

}

// Generate regional stats


function generateRegionStats(regionID, typeID) {

    statWaiting++;

    pgClient.query('SELECT price, is_bid, volume_remaining FROM market_data_orders WHERE mapregion_id = $1 AND invtype_id = $2 AND is_active = \'t\'', [regionID, typeID], function(err, result) {
        statWaiting--;
        if(err) {
            console.log('Error while fetching orders for regionStat generation:' + err);
        } else {

            // Aggregate arrays
            var bidPrices = [];
            var askPrices = [];

            // Put prices into array
            for(x = 0; x < result.rows.length; x++) {
                if(result.rows[x].is_bid === true) {
                    bidPrices.push(result.rows[x].price);
                } else {
                    askPrices.push(result.rows[x].price);
                }
            }

            // Check if we have prices for both bids and asks
            if(bidPrices.length > 0 && askPrices.length > 0) {
                // Convert arrays into Stats object
                bidPrices = new Stats(bidPrices);
                askPrices = new Stats(askPrices);

                // Filter top/bottom 5%
                bidPercentile5 = bidPrices.percentile(5);
                bidPercentile95 = bidPrices.percentile(95);
                bidPrices = bidPrices.band_pass(bidPercentile5, bidPercentile95);

                askPercentile5 = bidPrices.percentile(5);
                askPercentile95 = askPrices.percentile(95);
                askPrices = askPrices.band_pass(askPercentile5, askPercentile95);

                // Calculate various values
                bidMean = bidPrices.amean();
                bidMedian = bidPrices.median();
                bidStdDev = bidPrices.stddev();

                askMean = askPrices.amean();
                askMedian = askPrices.median();
                askStdDev = askPrices.stddev();

                //
                // Calculate weighted average
                //
                var bidPricesSum = 0;
                var bidPricesVolume = 0;

                var askPricesSum = 0;
                var askPricesVolume = 0;

                // Manually bandpass array
                for(x = 0; x < result.rows.length; x++) {
                    if(result.rows[x].is_bid === true) {
                        if(result.rows[x].price >= bidPercentile5 && result.rows[x].price <= bidPercentile95) {
                            bidPricesSum += result.rows[x].price * result.rows[x].volume_remaining;
                            bidPricesVolume += result.rows[x].volume_remaining;
                        }
                    } else {
                        if(result.rows[x].price >= askPercentile5 && result.rows[x].price <= askPercentile95) {
                            askPricesSum = result.rows[x].price * result.rows[x].volume_remaining;
                            askPricesVolume += result.rows[x].volume_remaining;
                        }
                    }
                }

                // Actually calculate the weighted average
                bidWeightedAverage = (bidPricesSum / bidPricesVolume);
                askWeightedAverage = (askPricesSum / askPricesVolume);

                // Generate dates
                var now = new Date();
                var now_utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toUTCString();

                // Build query values
                var queryValuesHistory = '(' + bidMean + ',' + bidWeightedAverage + ',' + bidMedian + ',' + askWeightedAverage + ',' + askMean + ',' + askMedian + ',' + bidPricesVolume + ',' + askPricesVolume + ',' + bidPercentile95 + ',' + askPercentile95 + ',' + regionID + ',' + typeID + ',\'' + now_utc + '\'::timestamp AT TIME ZONE \'UTC\',' + bidStdDev + ',' + askStdDev + ')';
                var queryValues = '(' + bidMean + ',' + bidWeightedAverage + ',' + bidMedian + ',' + askWeightedAverage + ',' + askMean + ',' + askMedian + ',' + bidPricesVolume + ',' + askPricesVolume + ',' + bidPercentile95 + ',' + askPercentile95 + ',' + regionID + ',' + typeID + ',' + bidStdDev + ',' + askStdDev + ')';

                // Replace NaN with 0
                queryValuesHistory = queryValuesHistory.replace(/NaN/g, '0');
                queryValues = queryValues.replace(/NaN/g, '0');

                // Build history query
                historyWaiting++;
                pgClient.query('WITH new_values (buymean, buyavg, buymedian, sellmean, sellavg, sellmedian, buyvolume, sellvolume, buy_95_percentile, sell_95_percentile, mapregion_id, invtype_id, date, buy_std_dev, sell_std_dev) AS (VALUES ' + queryValuesHistory + '), upsert as ( UPDATE market_data_itemregionstathistory o SET buymean = new_value.buymean, buyavg = new_value.buyavg, buymedian = new_value.buymedian, sellmean = new_value.sellmean, sellavg = new_value.sellavg, sellmedian = new_value.sellmedian, buyvolume = new_value.buyvolume, sellvolume = new_value.sellvolume, buy_95_percentile = new_value.buy_95_percentile, sell_95_percentile = new_value.sell_95_percentile, buy_std_dev = new_value.buy_std_dev, sell_std_dev = new_value.sell_std_dev FROM new_values new_value WHERE o.mapregion_id = new_value.mapregion_id AND o.invtype_id = new_value.invtype_id AND o.date = new_value.date AND o.date >= NOW() - \'1 day\'::INTERVAL RETURNING o.* ) INSERT INTO market_data_itemregionstathistory (buymean, buyavg, buymedian, sellmean, sellavg, sellmedian, buyvolume, sellvolume, buy_95_percentile, sell_95_percentile, mapregion_id, invtype_id, date, buy_std_dev, sell_std_dev) SELECT * FROM new_values WHERE NOT EXISTS (SELECT 1 FROM upsert up WHERE up.mapregion_id = new_values.mapregion_id AND up.invtype_id = new_values.invtype_id AND up.date = new_values.date) AND NOT EXISTS (SELECT 1 FROM market_data_orderhistory WHERE mapregion_id = new_values.mapregion_id AND invtype_id = new_values.invtype_id AND date = new_values.date)', function(err, result) {
                    if(err) {
                        console.log('RegionStatHistory upsert error:');
                        console.log(err);
                        if(config.extensiveLogging) console.log(queryValuesHistory);
                    } else {
                        pgClient.query('WITH new_values (buymean, buyavg, buymedian, sellmean, sellavg, sellmedian, buyvolume, sellvolume, buy_95_percentile, sell_95_percentile, mapregion_id, invtype_id, buy_std_dev, sell_std_dev) AS (VALUES ' + queryValues + '), upsert as ( UPDATE market_data_itemregionstathistory o SET buymean = new_value.buymean, buyavg = new_value.buyavg, buymedian = new_value.buymedian, sellmean = new_value.sellmean, sellavg = new_value.sellavg, sellmedian = new_value.sellmedian, buyvolume = new_value.buyvolume, sellvolume = new_value.sellvolume, buy_95_percentile = new_value.buy_95_percentile, sell_95_percentile = new_value.sell_95_percentile, buy_std_dev = new_value.buy_std_dev, sell_std_dev = new_value.sell_std_dev FROM new_values new_value WHERE o.mapregion_id = new_value.mapregion_id AND o.invtype_id = new_value.invtype_id RETURNING o.* ) INSERT INTO market_data_itemregionstathistory (buymean, buyavg, buymedian, sellmean, sellavg, sellmedian, buyvolume, sellvolume, buy_95_percentile, sell_95_percentile, mapregion_id, invtype_id, buy_std_dev, sell_std_dev) SELECT * FROM new_values WHERE NOT EXISTS (SELECT 1 FROM upsert up WHERE up.mapregion_id = new_values.mapregion_id AND up.invtype_id = new_values.invtype_id) AND NOT EXISTS (SELECT 1 FROM market_data_orderhistory WHERE mapregion_id = new_values.mapregion_id AND invtype_id = new_values.invtype_id)', function(err, result) {
                            historyWaiting--;
                            if(err) {
                                console.log('RegionStat upsert error:');
                                console.log(err);
                                if(config.extensiveLogging) console.log(queryValues);
                            } else {}
                        });
                    }
                });
            }
        }
    });
}

// Insert new EMDR stat datapoint
setInterval(function() {
    // Status codes
    // 0: Empty order messages
    // 1: Order Insert
    // 2: Old order (/ order update)
    // 3: Order update (/ old order)
    // 4: History message
    // 5: Order message
    // 6: History updates
    now = new Date(Date.now());

    // Note the compact callback pyramid of doom here
    pgClient.query('INSERT INTO market_data_emdrstats (status_type, status_count, message_timestamp) VALUES ($1, $2, $3)', [0, emdrStatsEmptyOrderMessages, now], function(err, result) {
        pgClient.query('INSERT INTO market_data_emdrstats (status_type, status_count, message_timestamp) VALUES ($1, $2, $3)', [1, emdrStatsOrderInserts, now], function(err, result) {
            pgClient.query('INSERT INTO market_data_emdrstats (status_type, status_count, message_timestamp) VALUES ($1, $2, $3)', [2, emdrStatsOrderUpdates, now], function(err, result) {
                pgClient.query('INSERT INTO market_data_emdrstats (status_type, status_count, message_timestamp) VALUES ($1, $2, $3)', [3, emdrStatsOrderUpdates, now], function(err, result) {
                    pgClient.query('INSERT INTO market_data_emdrstats (status_type, status_count, message_timestamp) VALUES ($1, $2, $3)', [4, emdrStatsHistoryMessages, now], function(err, result) {
                        pgClient.query('INSERT INTO market_data_emdrstats (status_type, status_count, message_timestamp) VALUES ($1, $2, $3)', [5, emdrStatsOrderMessages, now], function(err, result) {
                            pgClient.query('INSERT INTO market_data_emdrstats (status_type, status_count, message_timestamp) VALUES ($1, $2, $3)', [6, emdrStatsHistoryUpdates, now], function(err, result) {
                                // Rest values
                                emdrStatsEmptyOrderMessages = 0;
                                emdrStatsOrderInserts = 0;
                                emdrStatsOrderUpdates = 0;
                                emdrStatsHistoryMessages = 0;
                                emdrStatsOrderMessages = 0;
                                emdrStatsHistoryUpdates = 0;
                            });
                        });
                    });
                });
            });
        });
    });
}, config.emdrStatsInterval);


// Status
setInterval(function() {
    if(config.displayStats) {
        var dividend = config.statsInterval / 1000;
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
        now = new Date(Date.now());
        process.stdout.write('[' + now.toLocaleTimeString() + '] Receiving ' + (messagesTotal / dividend).toFixed() + ' (O:' + (messagesOrders / dividend).toFixed() + '/H:' + ((messagesTotal - messagesOrders) / dividend).toFixed() + ') messages per second. Performing ' + (orderUpserts / dividend).toFixed() + ' order upserts and ' + (historyUpserts / dividend).toFixed() + ' history upserts per second. Backlog: stdDev:' + stdDevWaiting + ' / orders: ' + upsertWaiting + ' / statistics: ' + statWaiting + ' / history: ' + historyWaiting);
    }

    // Reset counters
    messagesTotal = 0;
    messagesOrders = 0;
    orderUpserts = 0;
    historyUpserts = 0;
}, config.statsInterval);

// Newline
if(config.displayStats) {
    setInterval(function() {
        console.log('');
    }, config.statsNewline);
}

// Reconnect
// Voodoo code makes the zmq socket stay open
// Otherwise it would get removed by the garbage collection
setTimeout(function() {
    if(false) {
        zmqSocket.connect(relay);
    }
}, 1000 * 60 * 60 * 24 * 365);