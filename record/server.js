const express = require('express');
const { environment } = require('common');
const { main_handler } = require('./index');

// Constants
const PORT = 9000;
const HOST = '0.0.0.0';

// Web function invocation
const app = express();
app.use(express.json());

app.get('/*', (req, res) => {
  res.send('Hello Serverless Cloud Function , Web Function\n');
});

// Event function invocation
app.post('/event-invoke', async (req, res) => {
  const { headers, body } = req;
  console.log('headers', JSON.stringify(headers));
  console.log('body', JSON.stringify(body));

  // 初始化环境变量
  const { context } = environment.initialize(headers);

  await main_handler(req.body, context);

  res.send('record function have been invoked successfully');
});

var server = app.listen(PORT, HOST);
console.log(`SCF Running on http://${HOST}:${PORT}`);

server.timeout = 0; // never timeout
server.keepAliveTimeout = 0; // keepalive, never timeout
