/* eslint-disable @typescript-eslint/unbound-method */
import { BrowserClient } from '@sentry/browser';
import { getMainCarrier, Hub } from '@sentry/hub';
import * as hubModule from '@sentry/hub';
import * as utilsModule from '@sentry/utils'; // for mocking
import { getGlobalObject, isNodeEnv, logger } from '@sentry/utils';
import * as nodeHttpModule from 'http';

import { BrowserTracing } from '../src/browser/browsertracing';
import { addExtensionMethods } from '../src/hubextensions';
import { extractTraceparentData, TRACEPARENT_REGEXP } from '../src/utils';
import { addDOMPropertiesToGlobal, getSymbolObjectKeyByName } from './testutils';

addExtensionMethods();

// we have to add things into the real global object (rather than mocking the return value of getGlobalObject)
// because there are modules which call getGlobalObject as they load, which is too early for jest to intervene
addDOMPropertiesToGlobal(['XMLHttpRequest', 'Event', 'location', 'document']);

describe('Hub', () => {
  beforeEach(() => {
    jest.spyOn(logger, 'warn');
    jest.spyOn(logger, 'log');
    jest.spyOn(utilsModule, 'isNodeEnv');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('getTransaction()', () => {
    it('should find a sampled transaction which has been set on the scope', () => {
      const hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
      const transaction = hub.startTransaction({ name: 'dogpark' });
      hub.configureScope(scope => {
        scope.setSpan(transaction);
      });

      expect(hub.getScope()?.getTransaction()).toBe(transaction);
    });

    it('should find an unsampled transaction which has been set on the scope', () => {
      const hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
      const transaction = hub.startTransaction({ name: 'dogpark', sampled: false });
      hub.configureScope(scope => {
        scope.setSpan(transaction);
      });

      expect(hub.getScope()?.getTransaction()).toBe(transaction);
    });

    it("should not find an open transaction if it's not on the scope", () => {
      const hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
      hub.startTransaction({ name: 'dogpark' });

      expect(hub.getScope()?.getTransaction()).toBeUndefined();
    });
  });

  describe('transaction sampling', () => {
    describe('tracesSampleRate and tracesSampler options', () => {
      it("should call tracesSampler if it's defined", () => {
        const tracesSampler = jest.fn();
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(tracesSampler).toHaveBeenCalled();
      });

      it('should prefer tracesSampler to tracesSampleRate', () => {
        const tracesSampler = jest.fn();
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 1, tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(tracesSampler).toHaveBeenCalled();
      });

      it('tolerates tracesSampler returning a boolean', () => {
        const tracesSampler = jest.fn().mockReturnValue(true);
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        const transaction = hub.startTransaction({ name: 'dogpark' });

        expect(tracesSampler).toHaveBeenCalled();
        expect(transaction.sampled).toBe(true);
      });
    });

    describe('default sample context', () => {
      it('should extract request data for default sampling context when in node', () => {
        // make sure we look like we're in node
        (isNodeEnv as jest.Mock).mockReturnValue(true);

        // pre-normalization request object
        const mockRequestObject = ({
          headers: { ears: 'furry', nose: 'wet', tongue: 'panting', cookie: 'favorite=zukes' },
          method: 'wagging',
          protocol: 'mutualsniffing',
          hostname: 'the.dog.park',
          originalUrl: '/by/the/trees/?chase=me&please=thankyou',
        } as unknown) as nodeHttpModule.IncomingMessage;

        // The "as unknown as nodeHttpModule.IncomingMessage" casting above keeps TS happy, but doesn't actually mean that
        // mockRequestObject IS an instance of our desired class. Fix that so that when we search for it by type, we
        // actually find it.
        Object.setPrototypeOf(mockRequestObject, nodeHttpModule.IncomingMessage.prototype);

        // in production, the domain will have at minimum the request and the response, so make a response object to prove
        // that our code identifying the request in domain.members works
        const mockResponseObject = new nodeHttpModule.ServerResponse(mockRequestObject);

        // normally the node request handler does this, but that's not part of this test
        (getMainCarrier().__SENTRY__!.extensions as any).domain = {
          active: { members: [mockRequestObject, mockResponseObject] },
        };

        // Ideally we'd use a NodeClient here, but @sentry/tracing can't depend on @sentry/node since the reverse is
        // already true (node's request handlers start their own transactions) - even as a dev dependency. Fortunately,
        // we're not relying on anything other than the client having a captureEvent method, which all clients do (it's
        // in the abstract base class), so a BrowserClient will do.
        const tracesSampler = jest.fn();
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        // post-normalization request object
        expect(tracesSampler).toHaveBeenCalledWith(
          expect.objectContaining({
            request: {
              headers: { ears: 'furry', nose: 'wet', tongue: 'panting', cookie: 'favorite=zukes' },
              method: 'wagging',
              url: 'http://the.dog.park/by/the/trees/?chase=me&please=thankyou',
              cookies: { favorite: 'zukes' },
              query_string: 'chase=me&please=thankyou',
            },
          }),
        );
      });

      it('should extract window.location/self.location for default sampling context when in browser/service worker', () => {
        // make sure we look like we're in the browser
        (isNodeEnv as jest.Mock).mockReturnValue(false);

        const dogParkLocation = {
          hash: '#next-to-the-fountain',
          host: 'the.dog.park',
          hostname: 'the.dog.park',
          href: 'mutualsniffing://the.dog.park/by/the/trees/?chase=me&please=thankyou#next-to-the-fountain',
          origin: "'mutualsniffing://the.dog.park",
          pathname: '/by/the/trees/',
          port: '',
          protocol: 'mutualsniffing:',
          search: '?chase=me&please=thankyou',
        };

        getGlobalObject<Window>().location = dogParkLocation as any;

        const tracesSampler = jest.fn();
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(tracesSampler).toHaveBeenCalledWith(expect.objectContaining({ location: dogParkLocation }));
      });

      it('should add transaction context data to default sample context', () => {
        const tracesSampler = jest.fn();
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        const transactionContext = {
          name: 'dogpark',
          parentSpanId: '12312012',
          parentSampled: true,
        };

        hub.startTransaction(transactionContext);

        expect(tracesSampler).toHaveBeenLastCalledWith(expect.objectContaining({ transactionContext }));
      });

      it("should add parent's sampling decision to default sample context", () => {
        const tracesSampler = jest.fn();
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        const parentSamplingDecsion = false;

        hub.startTransaction({
          name: 'dogpark',
          parentSpanId: '12312012',
          parentSampled: parentSamplingDecsion,
        });

        expect(tracesSampler).toHaveBeenLastCalledWith(
          expect.objectContaining({ parentSampled: parentSamplingDecsion }),
        );
      });
    });

    describe('sample()', () => {
      it('should not sample transactions when tracing is disabled', () => {
        // neither tracesSampleRate nor tracesSampler is defined -> tracing disabled
        const hub = new Hub(new BrowserClient({}));
        const transaction = hub.startTransaction({ name: 'dogpark' });

        expect(transaction.sampled).toBe(false);
      });

      it('should not try to override sampling decision provided in transaction context', () => {
        // setting tracesSampleRate to 1 means that without the override, the sampling decision should be true
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
        const transaction = hub.startTransaction({ name: 'dogpark', sampled: false });

        expect(transaction.sampled).toBe(false);
      });

      it('should not sample transactions when tracesSampleRate is 0', () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 0 }));
        const transaction = hub.startTransaction({ name: 'dogpark' });

        expect(transaction.sampled).toBe(false);
      });

      it('should sample transactions when tracesSampleRate is 1', () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
        const transaction = hub.startTransaction({ name: 'dogpark' });

        expect(transaction.sampled).toBe(true);
      });
    });

    describe('isValidSampleRate()', () => {
      it("should reject tracesSampleRates which aren't numbers or booleans", () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 'dogs!' as any }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be a boolean or a number'));
      });

      it('should reject tracesSampleRates which are NaN', () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 'dogs!' as any }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be a boolean or a number'));
      });

      // the rate might be a boolean, but for our purposes, false is equivalent to 0 and true is equivalent to 1
      it('should reject tracesSampleRates less than 0', () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: -26 }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be between 0 and 1'));
      });

      // the rate might be a boolean, but for our purposes, false is equivalent to 0 and true is equivalent to 1
      it('should reject tracesSampleRates greater than 1', () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 26 }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be between 0 and 1'));
      });

      it("should reject tracesSampler return values which aren't numbers or booleans", () => {
        const tracesSampler = jest.fn().mockReturnValue('dogs!');
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be a boolean or a number'));
      });

      it('should reject tracesSampler return values which are NaN', () => {
        const tracesSampler = jest.fn().mockReturnValue(NaN);
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be a boolean or a number'));
      });

      // the rate might be a boolean, but for our purposes, false is equivalent to 0 and true is equivalent to 1
      it('should reject tracesSampler return values less than 0', () => {
        const tracesSampler = jest.fn().mockReturnValue(-12);
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be between 0 and 1'));
      });

      // the rate might be a boolean, but for our purposes, false is equivalent to 0 and true is equivalent to 1
      it('should reject tracesSampler return values greater than 1', () => {
        const tracesSampler = jest.fn().mockReturnValue(31);
        const hub = new Hub(new BrowserClient({ tracesSampler }));
        hub.startTransaction({ name: 'dogpark' });

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sample rate must be between 0 and 1'));
      });
    });

    it('should drop transactions with sampled = false', () => {
      const client = new BrowserClient({ tracesSampleRate: 0 });
      jest.spyOn(client, 'captureEvent');

      const hub = new Hub(client);
      const transaction = hub.startTransaction({ name: 'dogpark' });

      jest.spyOn(transaction, 'finish');
      transaction.finish();

      expect(transaction.sampled).toBe(false);
      expect(transaction.finish).toReturnWith(undefined);
      expect(client.captureEvent).not.toBeCalled();
    });

    describe('sampling inheritance', () => {
      it('should propagate sampling decision to child spans', () => {
        const hub = new Hub(new BrowserClient({ tracesSampleRate: Math.random() }));
        const transaction = hub.startTransaction({ name: 'dogpark' });
        const child = transaction.startChild({ op: 'ball.chase' });

        expect(child.sampled).toBe(transaction.sampled);
      });

      it('should propagate positive sampling decision to child transactions in XHR header', () => {
        const hub = new Hub(
          new BrowserClient({
            dsn: 'https://1231@dogs.are.great/1121',
            tracesSampleRate: 1,
            integrations: [new BrowserTracing()],
          }),
        );
        jest.spyOn(hubModule, 'getCurrentHub').mockReturnValue(hub);

        const transaction = hub.startTransaction({ name: 'dogpark' });
        hub.configureScope(scope => {
          scope.setSpan(transaction);
        });

        const request = new XMLHttpRequest();
        request.open('GET', '/chase-partners');

        // mock a response having been received successfully (we have to do it in this roundabout way because readyState
        // is readonly and changing it doesn't trigger a readystatechange event)
        Object.defineProperty(request, 'readyState', { value: 4 });
        request.dispatchEvent(new Event('readystatechange'));

        // this looks weird, it's true, but it's really just `request.impl.flag.requestHeaders` - it's just that the
        // `impl` key is a symbol rather than a string, and therefore needs to be referred to by reference rather than
        // value
        const headers = (request as any)[getSymbolObjectKeyByName(request, 'impl') as symbol].flag.requestHeaders;

        // check that sentry-trace header is added to request
        expect(headers).toEqual(expect.objectContaining({ 'sentry-trace': expect.stringMatching(TRACEPARENT_REGEXP) }));

        // check that sampling decision is passed down correctly
        expect(transaction.sampled).toBe(true);
        expect(extractTraceparentData(headers['sentry-trace'])!.parentSampled).toBe(true);
      });

      it('should propagate negative sampling decision to child transactions in XHR header', () => {
        const hub = new Hub(
          new BrowserClient({
            dsn: 'https://1231@dogs.are.great/1121',
            tracesSampleRate: 1,
            integrations: [new BrowserTracing()],
          }),
        );
        jest.spyOn(hubModule, 'getCurrentHub').mockReturnValue(hub);

        const transaction = hub.startTransaction({ name: 'dogpark', sampled: false });
        hub.configureScope(scope => {
          scope.setSpan(transaction);
        });

        const request = new XMLHttpRequest();
        request.open('GET', '/chase-partners');

        // mock a response having been received successfully (we have to do it in this roundabout way because readyState
        // is readonly and changing it doesn't trigger a readystatechange event)
        Object.defineProperty(request, 'readyState', { value: 4 });
        request.dispatchEvent(new Event('readystatechange'));

        // this looks weird, it's true, but it's really just `request.impl.flag.requestHeaders` - it's just that the
        // `impl` key is a symbol rather than a string, and therefore needs to be referred to by reference rather than
        // value
        const headers = (request as any)[getSymbolObjectKeyByName(request, 'impl') as symbol].flag.requestHeaders;

        // check that sentry-trace header is added to request
        expect(headers).toEqual(expect.objectContaining({ 'sentry-trace': expect.stringMatching(TRACEPARENT_REGEXP) }));

        // check that sampling decision is passed down correctly
        expect(transaction.sampled).toBe(false);
        expect(extractTraceparentData(headers['sentry-trace'])!.parentSampled).toBe(false);
      });

      it('should propagate sampling decision to child transactions in fetch header', () => {
        // TODO (kmclb)
      });

      it("should inherit parent's sampling decision when creating a new transaction if tracesSampler is undefined", () => {
        // tracesSampleRate = 1 means every transaction should end up with sampled = true, so make parent's decision the
        // opposite to prove that inheritance takes precedence over tracesSampleRate
        const hub = new Hub(new BrowserClient({ tracesSampleRate: 1 }));
        const parentSamplingDecsion = false;

        const transaction = hub.startTransaction({
          name: 'dogpark',
          parentSpanId: '12312012',
          parentSampled: parentSamplingDecsion,
        });

        expect(transaction.sampled).toBe(parentSamplingDecsion);
      });

      it("should ignore parent's sampling decision when tracesSampler is defined", () => {
        // this tracesSampler causes every transaction to end up with sampled = true, so make parent's decision the
        // opposite to prove that tracesSampler takes precedence over inheritance
        const tracesSampler = () => true;
        const parentSamplingDecsion = false;

        const hub = new Hub(new BrowserClient({ tracesSampler }));

        const transaction = hub.startTransaction({
          name: 'dogpark',
          parentSpanId: '12312012',
          parentSampled: parentSamplingDecsion,
        });

        expect(transaction.sampled).not.toBe(parentSamplingDecsion);
      });
    });
  });
});
