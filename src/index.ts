import * as axios from 'axios';
import {PrismaClient} from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.COIN_MARKET_CAP_API_KEY) {
  console.error('No Coin Market Cap API key provided.');
  process.exit(1);
}
const coinMarketCapApiKey = process.env.COIN_MARKET_CAP_API_KEY;
 
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

const coinMarketCap = new CoinMarketCapApi(coinMarketCapApiKey);
const prisma = new PrismaClient();

const main = async () => {
  const cryptoCurrencies = await coinMarketCap.getAllCryptoCurrencies();
  for (let i = 0; i < 10; i++) {
    const symbol = cryptoCurrencies[i].symbol;
    const price = await coinMarketCap.getPriceInSats(symbol);
    console.log(`${symbol}: ${price.priceSats} sats at ${price.date}`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  })