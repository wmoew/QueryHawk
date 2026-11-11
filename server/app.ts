import express, { ErrorRequestHandler, Request, Response } from 'express';
import cors from 'cors';
import 'dotenv/config';
import { ServerError } from '../types/types.ts';
import apiRoutes from './routes/apiRoutes.ts';

const app = express();

app.use(
  cors({
    origin: 'http://localhost:5173', // Your frontend's URL
    methods: ['GET', 'POST', 'DELETE', 'PUT'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true, // Allow cookies and credentials
  })
);
app.use(express.json());

// Request logging. Only the method and path are logged: headers carry JWTs
// and request bodies carry database connection strings with passwords.
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use('/api', apiRoutes);

app.use('*', (req: Request, res: Response) => {
  res.status(404).send('Endpoint does not exist.');
});

const errorHandler: ErrorRequestHandler = (
  err: ServerError,
  _req,
  res,
  _next
) => {
  const defaultErr: ServerError = {
    log: 'Express error handler caught unknown middleware error',
    status: 500,
    message: { err: 'An error occurred' },
  };
  const errorObj: ServerError = { ...defaultErr, ...err };
  console.log(errorObj.log);
  res.status(errorObj.status).json(errorObj.message);
};

app.use(errorHandler);

export default app;
