# Coin Price Tracker

## Database Schema Design

First of all, it's worth noting that in the database design, there isn't any need to distinguish between cryptocurrencies and fiat currencies. So in addition to comparing the prices of cryptocurrencies in fiat, this service is also able to compare crypto to crypto and fiat to fiat. The biggest design decision I had to make was whether the database would:

1. Store prices between many different pairs of currencies
2. Use one currency as a baseline that we store prices of all other currencies relative to

The first option is quicker and easier to implement, but has a few issues:

1. Duplicate Data - We could accidentally end up storing the price of currency A relative to currency B _and_ the price of currency B relative to currency A.
2. Self-Inconsistency of Data - If we have the price of currency A <-> currency B, currency B <-> currency C and currency C <-> currency A, it's possible that the prices at a given point in time are incongruent with each other.
3. Rigidity - If we have the price of currency A <-> currency B and currency B <-> currency C, we can calculate the price of currency A <-> currency C. But without any base currency, finding which currencies to hop through will be difficult, likely requiring a pathfinding algorithm to search through all of the currencies that we're storing.

For these reasons, it makes more sense to store all prices relative to a single base currency. This eliminates any chance of storing duplicate data. since we're not directly storing price data of the base currency. It eliminates any self-inconsistency of data since there's always exactly one way to calculate the price of one currency compared to any other currency. It solves the problem of rigidity as well, for the same reason. We'll use Bitcoin as our base currency since our business is built around Bitcoin and, while the US Dollar, Euro, or other currencies may fall away, if Bitcoin dies then our company and hence this service is rendered useless.