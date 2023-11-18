import * as axios from 'axios';
import {PrismaClient} from '@prisma/client';
import dotenv from 'dotenv';
import express, {Request, Response} from 'express';

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

const app = express();
const port = 3000;

app.get('/priceInSats/:symbol', async (req: Request, res: Response) => {
  const prices = await prisma.price.findMany({
    where: {
      currency: {
        symbol: {
          equals: req.params.symbol
        }
      }
    }
  });
  
  res.send(prices.map((price) => ({priceSats: price.priceSats, date: price.dateTime})));
});

app.listen(port, () => {
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