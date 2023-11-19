import {BtcPricePoint, PricePoint} from '.';


const interpolatePrice = (data: BtcPricePoint[], targetTime: Date): number | null => {
  // Check for an exact match.
  const exactMatch = data.find(d => d.date.getTime() === targetTime.getTime());
  if (exactMatch) {
    return exactMatch.priceSats;
  }

  const closestBefore = data.filter(d => d.date < targetTime).pop();
  const closestAfter = data.find(d => d.date > targetTime);

  if (!closestBefore || !closestAfter) {
    if (closestBefore) {
      return closestBefore.priceSats;
    } else if (closestAfter) {
      return closestAfter?.priceSats;
    } else {
      // This branch doesn't do anything, but it makes the compiler happy.
      return null
    }
  }

  const timeDiff = closestAfter.date.getTime() - closestBefore.date.getTime();
  const priceDiff = closestAfter.priceSats - closestBefore.priceSats;

  const timeFraction =
    (targetTime.getTime() - closestBefore.date.getTime()) / timeDiff;

  return closestBefore.priceSats + timeFraction * priceDiff;
};


const getAllDates = (
  currency1: BtcPricePoint[],
  currency2: BtcPricePoint[]
): Date[] => {
  const dateSet = new Set<number>();
  currency1.concat(currency2).forEach(item => dateSet.add(item.date.getTime()));
  return Array.from(dateSet).sort().map(time => new Date(time));
};

export const computeDirectExchangeRate = (
  currency1: BtcPricePoint[],
  currency2: BtcPricePoint[]
): PricePoint[] => {
  const allDates = getAllDates(currency1, currency2);
  let results: (PricePoint | null)[] = [];

  for (let date of allDates) {
      const interpolatedPrice1 = interpolatePrice(currency1, date);
      const interpolatedPrice2 = interpolatePrice(currency2, date);

      if (interpolatedPrice1 === null || interpolatedPrice2 === null) {
          results.push(null);
      } else {
          results.push({
              price: interpolatedPrice1 / interpolatedPrice2,
              date: date
          });
      }
  }

  return results.filter(r => r !== null) as PricePoint[];
};