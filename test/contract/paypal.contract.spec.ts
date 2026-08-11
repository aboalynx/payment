import { createPaypalGateway } from '../../src/gateways/paypal/paypal.gateway';
import { describeGatewayContract } from './gateway-contract';

describeGatewayContract('paypal', () =>
  createPaypalGateway({
    clientId: 'id',
    clientSecret: 'secret',
    environment: 'sandbox',
    webhookId: 'WH-ID',
  }),
);
