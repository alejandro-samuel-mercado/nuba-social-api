import 'dotenv/config';
import http from 'http';
import { createApp } from './app';
import { initSocket } from './lib/socket';
import { prisma } from './lib/prisma';

const PORT = Number(process.env.PORT) || 4001;

const app = createApp();
const server = http.createServer(app);
initSocket(server);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Nuba Club API corriendo en http://0.0.0.0:${PORT}`);
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
