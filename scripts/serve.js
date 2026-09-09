import { createServer } from 'node:http';
import { createHandler } from '../src/handler.js';
const handler = createHandler();
const port = Number(process.env.PORT || 3000);
createServer(handler).listen(port, '127.0.0.1', () => console.log(`API local: http://127.0.0.1:${port}`));
