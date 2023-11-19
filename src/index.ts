import * as axios from 'axios';
import {PrismaClient} from '@prisma/client';
import dotenv from 'dotenv';
import express, {Request, Response} from 'express';
import {computeDirectExchangeRate} from './priceConversion';

dotenv.config();

if (!process.env.COIN_MARKET_CAP_API_KEY) {
  console.error('No Coin Market Cap API key provided.');
  process.exit(1);
}
 
const axiosClient = axios.default.create({});

interface CoinMarketCapCryptoCurrency {
  id: number;
  rank: number;
  name: string;
  symbol: string;
  slug: string;
  is_active: number;
  first_historical_data: string;
  last_historical_data: string;
  platform: any;
}

class CoinMarketCapApi {
  constructor(private readonly apiKey: string) {}

  async getAllCryptoCurrencies(): Promise<CoinMarketCapCryptoCurrency[]> {
    const res = await axiosClient.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/map', {
      headers: {
        'X-CMC_PRO_API_KEY': this.apiKey
      }
    });
    return res.data.data;
  }

  async getAllFiatCurrencies(): Promise<CoinMarketCapCryptoCurrency[]> {
    const res = await axiosClient.get('https://pro-api.coinmarketcap.com/v1/fiat/map', {
      headers: {
        'X-CMC_PRO_API_KEY': this.apiKey
      }
    });
    return res.data.data;
  }

  /**
   * Get the most recent sat-based price of a cryptocurrency.
   * @param symbol The symbol of the cryptocurrency to get the price of.
   * @returns The price in satoshis and the date of the price.
   */
  async getPriceInSats(symbol: string): Promise<{priceSats: number, date: Date}> {
    const res = await axiosClient.get('https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest', {
      params: {
        symbol: 'BTC',
        convert: symbol
      },
      headers: {
        'X-CMC_PRO_API_KEY': this.apiKey
      }
    });
    const quote = res.data.data['BTC'][0].quote[symbol];
    const bitcoinPriceInSymbol = quote.price;
    return {priceSats: 1 / bitcoinPriceInSymbol * 100000000, date: new Date(quote.last_updated)};
  }
}

const coinMarketCap = new CoinMarketCapApi(process.env.COIN_MARKET_CAP_API_KEY);
const prisma = new PrismaClient();

interface Currency {
  name: string;
  symbol: string;
}

const trackedCurrencies: Currency[] = [
  {name: 'United States Dollar', symbol: 'USD'},
  {name: 'Euro', symbol: 'EUR'},
  {name: 'Ethereum', symbol: 'ETH'},
  {name: 'Litecoin', symbol: 'LTC'},
  {name: 'Bitcoin Cash', symbol: 'BCH'},
  {name: 'Ripple', symbol: 'XRP'},
  {name: 'Binance Coin', symbol: 'BNB'}
];

class Cache {
  // The time-to-live of the cache in milliseconds. Any data older than this
  // will be removed from the cache.
  readonly ttlMillis = 24 * 60 * 60 * 1000;

  // Cached price data by currency symbol. Prices are stored in ascending order
  // by date.
  private cache: Map<string, BtcPricePoint[]> = new Map<string, BtcPricePoint[]>();

  // Add a price point to the cache. If the price point is already in the cache
  // or doesn't belong in it, it will not be added.
  addPricePoint(symbol: string, price: BtcPricePoint): void {
    // If price point is already older than the time-to-live, don't add it.
    const now = new Date();
    if (now.getTime() - price.date.getTime() > this.ttlMillis) {
      return;
    }

    // If the symbol is not already in the cache, add it.
    if (!this.cache.has(symbol)) {
      this.cache.set(symbol, [price]);
      return;
    } else {
      const prices = this.cache.get(symbol);
      if (!prices) {
        // This should never happen.
        return;
      }

      // If the price point is already in the cache, don't add it.
      if (prices.find(p => p.date.getTime() === price.date.getTime())) {
        return;
      }

      // Otherwise, add it to the cache in ascending order by date.
      let i = 0;
      for (; i < prices.length; i++) {
        if (prices[i].date.getTime() > price.date.getTime()) {
          break;
        }
      }
      // Insert the price point at the correct index. We're doing this outside
      // so that we add the price point to the end of the array if it's the
      // newest price point.
      prices.splice(i, 0, price);
    }
  }

  get(symbol: string): BtcPricePoint[] | undefined {
    return this.cache.get(symbol);
  }

  // Remove all data older than the time-to-live. This should be called
  // periodically to remove outdated data.
  cleanup(): void {
    const now = new Date();
    this.cache.forEach((prices, symbol) => {
      const filteredPrices = prices.filter(price => now.getTime() - price.date.getTime() <= this.ttlMillis);
      if (filteredPrices.length > 0) {
        this.cache.set(symbol, filteredPrices);
      } else {
        this.cache.delete(symbol);
      }
    });
  }
}

const cache = new Cache();

const app = express();
const port = 3000;

const isInteger = (str: string): boolean => {
  return !isNaN(parseInt(str)) && Number.isInteger(parseFloat(str));
};

export interface BtcPricePoint {
  priceSats: number;
  date: Date;
}

export interface PricePoint {
  price: number;
  date: Date;
}

// Get the price of a currency in satoshis.
//
// Query parameters:
//   limit: The maximum number of price points to return.
//   offset: The number of prices to skip.
//   startDate: The date to start querying prices from (in milliseconds since
//              the unix epoch). This filter is performed before the limit and
//              offset are applied.
//   sortOrder: The order to sort the prices in. Either "asc" or "desc".
//
// Returns an array of objects with the following fields:
//   priceSats: The price of the cryptocurrency in satoshis.
//   date: The date of the price.
app.get('/priceInSats/:symbol', async (req: Request, res: Response<BtcPricePoint[] | string>) => {
  if (req.query.limit  && !isInteger(req.query.limit as string)) {
    return res.status(400).send('Limit must be an integer.');
  }
  // Default to 10 if not provided.
  const limit = parseInt(req.query.limit as string, 10) || 10;
  if (limit < 0) {
    return res.status(400).send('Limit cannot be negative.');
  }

  if (req.query.offset && !isInteger(req.query.offset as string)) {
    return res.status(400).send('Offset must be an integer.');
  }
  // Default to 0 if not provided.
  const offset = parseInt(req.query.offset as string, 10) || 0;
  if (offset < 0) {
    return res.status(400).send('Offset cannot be negative.');
  }

  if (req.query.startDate && !isInteger(req.query.startDate as string)) {
    return res.status(400).send('Start date must be an integer (representing ' +
                                'milliseconds since the unix epoch).');
  }
  let startDate = parseInt(req.query.startDate as string, 10) || undefined;
  if (startDate && startDate < 0) {
    return res.status(400).send('Start date cannot be negative.');
  }

  let sortOrder: 'asc' | 'desc' = 'asc';
  if (req.query.sortOrder) {
    if (req.query.sortOrder !== 'asc' && req.query.sortOrder !== 'desc') {
      return res.status(400).send('Sort order must be either "asc" or "desc".');
    }
    sortOrder = req.query.sortOrder;
  }

  const cachedResults = cache.get(req.params.symbol);

  // If the cache contains data newer than the start date, we can just return
  // the cached data.
  if (startDate &&
      cachedResults &&
      cachedResults[0].date.getTime() > startDate) {
    // The Typescript type checker doesn't know whether the `.filter()` will
    // keep running after this `if` statement, so we need to copy the start date
    // into a new variable to make the type checker happy.
    const peggedStartDate = startDate;

    console.log('Using cached results.');
    return res.send(cachedResults.filter(price => price.date.getTime() > peggedStartDate));
  }

  const prices = await prisma.price.findMany({
    where: {
      currency: {
        symbol: {
          equals: req.params.symbol
        }
      },
      dateTime: {
        gt: startDate ? new Date(startDate) : undefined
      }
    },
    orderBy: {
      dateTime: sortOrder
    },
    take: limit,
    skip: offset
  });

  res.send(prices.map((price) => ({
    priceSats: price.priceSats,
    date: price.dateTime
  })));
});

// Get the price of a currency in another currency. Note that this does not yet
// support using Bitcoin (BTC) as the base currency or the priced currency.
// Please use the /priceInSats endpoint for that.
//
// Query parameters:
//   limit: The maximum number of price points to return.
//   offset: The number of prices to skip.
//   startDate: The date to start querying prices from (in milliseconds since
//              the unix epoch). This filter is performed before the limit and
//              offset are applied.
//   sortOrder: The order to sort the prices in. Either "asc" or "desc".
//
// Returns an array of objects with the following fields:
//   price: The price of the the priced currency measured in units of the base
//          currency.
//   date: The date of the price.
app.get('/price/:baseSymbol/:pricedSymbol', async (req: Request, res: Response<PricePoint[] | string>) => {
  if (req.query.limit  && !isInteger(req.query.limit as string)) {
    return res.status(400).send('Limit must be an integer.');
  }
  // Default to 10 if not provided.
  const limit = parseInt(req.query.limit as string, 10) || 10;
  if (limit < 0) {
    return res.status(400).send('Limit cannot be negative.');
  }

  if (req.query.offset && !isInteger(req.query.offset as string)) {
    return res.status(400).send('Offset must be an integer.');
  }
  // Default to 0 if not provided.
  const offset = parseInt(req.query.offset as string, 10) || 0;
  if (offset < 0) {
    return res.status(400).send('Offset cannot be negative.');
  }

  if (req.query.startDate && !isInteger(req.query.startDate as string)) {
    return res.status(400).send('Start date must be an integer (representing ' +
                                'milliseconds since the unix epoch).');
  }
  let startDate = parseInt(req.query.startDate as string, 10) || undefined;
  if (startDate && startDate < 0) {
    return res.status(400).send('Start date cannot be negative.');
  }

  let sortOrder: 'asc' | 'desc' = 'asc';
  if (req.query.sortOrder) {
    if (req.query.sortOrder !== 'asc' && req.query.sortOrder !== 'desc') {
      return res.status(400).send('Sort order must be either "asc" or "desc".');
    }
    sortOrder = req.query.sortOrder;
  }

  const cachedBaseCurrencyResults = cache.get(req.params.baseSymbol);
  const cachedPricedCurrencyResults = cache.get(req.params.pricedSymbol);

  let baseCurrencyPrices: BtcPricePoint[] | undefined = undefined;
  let pricedCurrencyPrices: BtcPricePoint[] | undefined = undefined;

  // If the cache contains data newer than the start date, we can just return
  // the cached data.
  if (startDate &&
      cachedBaseCurrencyResults &&
      cachedBaseCurrencyResults[0].date.getTime() > startDate) {
    // The Typescript type checker doesn't know whether the `.filter()` will
    // keep running after this `if` statement, so we need to copy the start date
    // into a new variable to make the type checker happy.
    const peggedStartDate = startDate;

    console.log('Using cached results.');
    baseCurrencyPrices = cachedBaseCurrencyResults.filter(
      price => price.date.getTime() > peggedStartDate);
  }

  // If the cache contains data newer than the start date, we can just return
  // the cached data.
  if (startDate &&
    cachedPricedCurrencyResults &&
    cachedPricedCurrencyResults[0].date.getTime() > startDate) {
    // The Typescript type checker doesn't know whether the `.filter()` will
    // keep running after this `if` statement, so we need to copy the start date
    // into a new variable to make the type checker happy.
    const peggedStartDate = startDate;

    console.log('Using cached results.');
    pricedCurrencyPrices = cachedPricedCurrencyResults.filter(
      price => price.date.getTime() > peggedStartDate);
  }

  if (baseCurrencyPrices === undefined) {
    baseCurrencyPrices = (await prisma.price.findMany({
      where: {
        currency: {
          symbol: {
            equals: req.params.baseSymbol
          }
        },
        dateTime: {
          gt: startDate ? new Date(startDate) : undefined
        }
      },
      orderBy: {
        dateTime: sortOrder
      },
      take: limit,
      skip: offset
    })).map((point) => ({
      priceSats: point.priceSats,
      date: point.dateTime
    }));
  }

  if (pricedCurrencyPrices === undefined) {
    pricedCurrencyPrices = (await prisma.price.findMany({
      where: {
        currency: {
          symbol: {
            equals: req.params.pricedSymbol
          }
        },
        dateTime: {
          gt: startDate ? new Date(startDate) : undefined
        }
      },
      orderBy: {
        dateTime: sortOrder
      },
      take: limit,
      skip: offset
    })).map((point) => ({
      priceSats: point.priceSats,
      date: point.dateTime
    }));
  }

  res.send(computeDirectExchangeRate(pricedCurrencyPrices, baseCurrencyPrices));
});

app.listen(port, async () => {
  // Seed the cache with the latest price data of all tracked currencies from
  // our DB.
  console.log('Seeding cache...');
  for (let i = 0; i < trackedCurrencies.length; i++) {
    const currency = trackedCurrencies[i];
    const prices = await prisma.price.findMany({
      where: {
        currency: {
          symbol: {
            equals: currency.symbol
          }
        },
        dateTime: {
          gt: new Date(Date.now() - cache.ttlMillis)
        }
      }
    });
    prices.forEach(price => {
      cache.addPricePoint(currency.symbol, {
        priceSats: price.priceSats,
        date: price.dateTime
      });
    });
  }
  console.log('Done seeding cache.');
  console.log(`Server is listening on port ${port}.`);
});

const ingestData = async () => {
  // Create SQL entries for all tracked currencies, updating the name if it
  // already exists.
  for (let i = 0; i < trackedCurrencies.length; i++) {
    const cryptoCurrency = trackedCurrencies[i];
    await prisma.currency.upsert({
      where: {
        symbol: cryptoCurrency.symbol
      },
      create: cryptoCurrency,
      update: {
        name: cryptoCurrency.name
      }
    });
  }

  // Get the price of all tracked currencies in satoshis and store them in the
  // database.
  for (let i = 0; i < trackedCurrencies.length; i++) {
    const currency = trackedCurrencies[i];
    const price = await coinMarketCap.getPriceInSats(currency.symbol);
    cache.addPricePoint(currency.symbol, price);
    await prisma.price.create({
      data: {
        priceSats: price.priceSats,
        dateTime: price.date,
        currency: {
          connectOrCreate: {
            where: {symbol: currency.symbol},
            create: currency
          }
        }
      }
    });
  }
};

const cleanup = async () => {
  await prisma.$disconnect();
  process.exit(0);
}

setInterval(async () => {
  console.log('Cleaning up cache...');
  cache.cleanup();
  console.log('Done cleaning up cache.');

  console.log('Ingesting latest price data...');
  try {
    await ingestData();
    console.log('Done ingesting latest price data.');
  } catch (err) {
    console.error(`Failed to ingest latest price data: ${err}`);
  }
}, 60000);

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);