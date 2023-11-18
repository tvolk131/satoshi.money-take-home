import {PrismaClient} from '@prisma/client';

const prisma = new PrismaClient();

const main = async () => {
  const cryptocurrencies = await prisma.currency.findMany();
  console.log(cryptocurrencies);
  const cryptocurrency = await prisma.currency.create({
    data: {
      name: 'Bitcoin Cash',
      symbol: 'BCH',
    },
  });
  console.log(cryptocurrency);
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