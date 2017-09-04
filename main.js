require('dotenv').config();

const fs = require('fs');
const slayer = require('slayer');
const colors = require('colors');
const term = require('terminal-kit').terminal;
const R = require('ramda');
const KrakenCli = require('./krakenCli');


const ENV = process.env.ENV || 'DEV';

const INTERACTIVE = false;
const INTERVAL = 15;
const FEE_PCT = 0.003;
const THRESHOLD = 1.004;
const THRESHOLD_TO_START_EVALUATING_SPIKES = 0;
const MINIMAL_VOLUME = 0.02;
const LOG_TO_FILE = false;
const SIMPLE_OUTPUT = false;

const logger = (level, msg) => {
    const output = `[${timestamp()}][${ENV}][${level.toUpperCase()}] - ${msg}`;
    if (SIMPLE_OUTPUT) console.log(output);
    if (LOG_TO_FILE) fs.appendFileSync('console.log', output + '\n');
};

const timestamp = () => new Date().toISOString();

const scaleBetween = (unscaledNum, minAllowed, maxAllowed, min, max) => {
    return (maxAllowed - minAllowed) * (unscaledNum - min) / (max - min) + minAllowed;
};

const draw = (uiState) => {
    term.clear();

    let row = 1;
    R.forEach((item) => {
        term(((term.height - 4) - 10 < row ? '>' : ' ') + item);
        term.nextLine();
        row++;
    }, R.takeLast(term.height - 4, uiState.quoteLines));

    term(uiState.lastType);
    term.nextLine();
    term(uiState.lastAction);
    term.nextLine();
    term(uiState.lastValues);
    term.nextLine();
    term('---------------------------');
    term.nextLine();
};

const terminate = () => {
    term.grabInput(false);
    setTimeout(function () { process.exit(); }, 100);
};

(async () => {
    try {
        const krakenCli = new KrakenCli();

        let USD = 200;
        let XBT = 0;
        let totalPaid = 0;
        let currentlyWorthy = 0;
        let initialValue = 0;
        let finalValue = 0;

        const baseQuotes = await krakenCli.getQuotes('XXBTZUSD', INTERVAL);
        let timeSeries = [];                // Time serie with all events
        let maxValue = Number.MIN_VALUE;    // Max value found
        let minValue = Number.MAX_VALUE;    // Min value found
        let lastBuy = 0;                    // XBT buy quote 
        let lastSell = 0;                   // XBT sell quote 
        let actionsCount = 0;               // How many buys and sells were made

        const uiState = {
            quoteLines: [],
            lastType: null,
            lastAction: null,
            lastValues: null
        };

        const loop = async (i) => {
            if (i < baseQuotes.length) {
                const rawQuote = baseQuotes[i];

                maxValue = Math.max(maxValue, rawQuote[4]);
                minValue = Math.min(minValue, rawQuote[4]);
                timeSeries.push({
                    index: i,           // Original index
                    date: rawQuote[0],  // Quote date
                    value: rawQuote[4], // Quote value
                    action: 'none',     // Action done
                    mark: 'none'        // Marker (high, low)
                });

                const quote = R.last(timeSeries);

                uiState.quoteLines = [];

                /*                
                // Get the last N series from the last buy or sell. Not GOOD :( 
                const lastIndexSell = R.findLastIndex(R.propEq('action', 'sell'), timeSeries);
                const lastIndexBuy = R.findLastIndex(R.propEq('action', 'buy'), timeSeries);
                const lastIndexToStrip = Math.max(lastIndexBuy, lastIndexSell);
                const timeSeriesToAnalyse = (lastIndexToStrip >= 0 ? R.takeLast(timeSeries.length - lastIndexToStrip - 1, timeSeries) : timeSeries);
                */

                // Just get the last 10 items
                const timeSeriesToAnalyse = R.takeLast(Math.min(timeSeries.length, 10), timeSeries);

                const highTimeSeries = timeSeriesToAnalyse;
                const lowTimeSeries = timeSeriesToAnalyse.map((timeSerie) => {
                    return {
                        date: timeSerie.date,
                        value: maxValue - timeSerie.value
                    };
                });

                // Find the spikes and mark the timeSeries original array with this information
                (await slayer()
                    .y(item => item.value)
                    .fromArray(highTimeSeries))
                    .map((spike) => timeSeries[timeSeriesToAnalyse[spike.x].index].mark = 'high');
                (await slayer()
                    .y(item => item.value)
                    .fromArray(lowTimeSeries))
                    .map((spike) => timeSeries[timeSeriesToAnalyse[spike.x].index].mark = 'low');

                if (highTimeSeries.length > THRESHOLD_TO_START_EVALUATING_SPIKES) {
                    let action = 'skip';

                    let space = 0;
                    for (var reverseIndex = timeSeries.length - 1; reverseIndex >= 0; reverseIndex--) {
                        let timeSerie = timeSeries[reverseIndex];

                        if (timeSerie.action == 'buy' || timeSerie.action == 'sell') break;

                        if (timeSerie.mark == 'none') space++;

                        // Wait or two unmarked series to buy
                        if (timeSerie.mark == 'high') {
                            if (space >= 2) {
                                action = 'sell';
                                break;
                            }
                        } else if (timeSerie.mark == 'low') {
                            if (space >= 2) {
                                action = 'buy';
                                break;
                            }
                        }
                        space++;
                    }

                    uiState.lastType = `Last type was ${action}`;
                    logger(uiState.lastType);

                    if (action == 'buy') {
                        if (USD > 0) {
                            if ((USD / quote.value) > MINIMAL_VOLUME) {
                                const USDToSend = (USD - (USD * FEE_PCT));
                                const XBTToBuy = USDToSend / quote.value;
                                XBT += XBTToBuy;
                                totalPaid += USD;
                                USD -= USD;
                                quote.action = 'buy';
                                lastBuy = quote.value;
                                uiState.lastAction = 'Bought';
                                logger('INFO', uiState.lastAction);
                                actionsCount++;

                                // Keep track of the first total amount of XBT so we can compare later if it was worth at all to buy and sell.
                                if (!initialValue) initialValue = XBT;
                            } else {
                                uiState.lastAction = 'Not reached the minimum volume.';
                                logger('INFO', uiState.lastAction);
                            }
                        } else {
                            uiState.lastAction = 'Not enough USD funds.';
                            logger('INFO', uiState.lastAction);
                        }
                    } else if (action == 'sell') {
                        if (XBT > 0) {
                            if (XBT > MINIMAL_VOLUME) {
                                const diff = quote.value / lastBuy;
                                if (lastBuy == 0 || diff > THRESHOLD) {

                                    const XBTToSell = XBT;
                                    const XBTValue = XBT * quote.value;
                                    const USDToReceive = XBTValue - (XBTValue * FEE_PCT);
                                    XBT -= XBTToSell;
                                    totalPaid -= USDToReceive;
                                    USD += USDToReceive;
                                    lastSell = quote.value;
                                    quote.action = 'sell';
                                    uiState.lastAction = 'Sold';
                                    logger('INFO', uiState.lastAction);
                                    actionsCount++;
                                } else {
                                    uiState.lastAction = 'Bellow threshold';
                                    logger('INFO', uiState.lastAction);
                                }
                            } else {
                                uiState.lastAction = 'Not reached the minimum volume.';
                                logger('INFO', uiState.lastAction);
                            }
                        } else {
                            uiState.lastAction = 'Not enough XBT funds.';
                            logger('INFO', uiState.lastAction);
                        }
                    } else {
                        uiState.lastAction = 'Skipping';
                        logger('INFO', uiState.lastAction);
                    }
                }

                timeSeries.forEach((item) => {
                    let color = colors.white.bgBlack;
                    let symbol = '';
                    if (item.mark == 'high') {
                        symbol += 'h';
                        color = colors.green;
                    } else if (item.mark == 'low') {
                        symbol += 'l';
                        color = colors.red;
                    }
                    if (item.action == 'buy') {
                        symbol += 'b';
                        color = color.bgBlue;
                    } else if (item.action == 'sell') {
                        symbol += 's';
                        color = color.bgYellow;
                    }

                    uiState.quoteLines.push(`${(new Date(item.date * 1000)).toLocaleString()} - ${' '.repeat(Math.round(scaleBetween(Number.parseFloat(item.value), 0, 50, minValue, maxValue)))} ${symbol}${color(item.value)}`);
                    logger('info', R.last(uiState.quoteLines));
                });

                currentlyWorthy = XBT * quote.value;
                finalValue = currentlyWorthy + USD;

                uiState.lastValues = `-- USD: ${USD} -- XBT: ${XBT.toFixed(6)} -- Paid: ${totalPaid.toFixed(2)} -- Cur. Worthy: ${currentlyWorthy.toFixed(2)} -- LastBuy: ${lastBuy} -- LastSell: ${lastSell} -- Actions: ${actionsCount} -- Initial Value: ${(initialValue * quote.value).toFixed(2)} -- Final Value: ${finalValue.toFixed(2)} --`;
                logger('info', uiState.lastValues);

                if (!SIMPLE_OUTPUT) draw(uiState);
            }
        };

        // If interactive, wait for a key press to process next tick
        if (INTERACTIVE) {
            term.grabInput();
            let i = 0;
            term.on('key', (name) => {
                if (name === 'CTRL_C') { terminate(); }
                loop(i);
                i++;
            });
        } else {
            for (let i = 0; i < baseQuotes.length; i++) {
                await loop(i);
            }
        }

    } catch (e) {
        logger('error', `Exception: ${e.message} - ${e.stack}`);
    }
})();

/*
Plan:

Check balance
Update time series
    Get quote for each COIN
    Add each quote to time series (limit to N entries base on time interval)
    Smooth each time series
Evaluate buy/sell
    if it has COIN balance and is higher than the MINIMUM
    Get last N quotes, find the hight peaks
    Get last N quotes, inverti, find the hight peaks
    Order then
    If the last peak is a down peak, set buy mode
    If the last peak is a up peak, set sell mode
    If buy mode
        If the last peak + THRESHOLD > current price, buy
    If sell mode
        If the last peak - THRESHOLD < current price, sell    
Execute actions
    Execute action
    Update transactions
    Annotate transaction sell value
*/