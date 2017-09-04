const KrakenClient = require('kraken-api');

class KrakenCli {
    constructor() {
        this.kraken = new KrakenClient(process.env.KEY, process.env.SECRET, {
            timeout: 60 * 60 * 48 * 1000
        });
    }

    async getBalance() {
        //this.kraken.api('Balance');
        let response = { 'error': [], 'result': { 'ZUSD': '500.0000', 'XXBT': '0.5' } };
        if (response.error != null && response.error.length > 0) throw new Error(response.error);
        return response.result;
    }

    async getQuotes(pair, interval) {
        const response = await this.kraken.api('OHLC', {
            pair: pair,
            interval: interval,
        });
        if (response.error != null && response.error.length > 0) throw new Error(response.error);
        return response.result[pair];
    }
}

module.exports = KrakenCli;
