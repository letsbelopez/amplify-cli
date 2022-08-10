import { OperationServer } from './operations';
import { AmplifyAppSyncSimulator } from '..';
import { AppSyncSimulatorServerConfig } from '../type-definition';
import { Server, createServer } from 'http';
import { fromEvent } from 'promise-toolbox';
import { address as getLocalIpAddress } from 'ip';
import { AppSyncSimulatorSubscriptionServer } from './websocket-subscription';
import getPort from 'get-port';

const BASE_PORT = 8900;
const MAX_PORT = 9999;

export class AppSyncSimulatorServer {
  private _operationServer: OperationServer;
  private _httpServer: Server;
  private _realTimeSubscriptionServer: AppSyncSimulatorSubscriptionServer;
  private _url: string;

  constructor(private config: AppSyncSimulatorServerConfig, private simulatorContext: AmplifyAppSyncSimulator) {
    this._operationServer = new OperationServer(config, simulatorContext);
    this._httpServer = createServer(this._operationServer.app);
    this._realTimeSubscriptionServer = new AppSyncSimulatorSubscriptionServer(simulatorContext, this._httpServer, '/graphql/realtime');
  }

  async start(): Promise<void> {
    let port = this.config.port;

    await this._realTimeSubscriptionServer.start();

    if (!port) {
      port = await getPort({
        port: getPort.makeRange(BASE_PORT, MAX_PORT),
      })
    } else {
      try {
        await getPort({
          port,
        })
      } catch (e) {
        throw new Error(`Port ${port} is already in use. Please kill the program using this port and restart Mock`);
      }
    }

    this._httpServer.listen(port);
    await fromEvent(this._httpServer, 'listening').then(() => {
      this._url = `http://${getLocalIpAddress()}:${port}`;
    });
  }

  stop() {
    this._realTimeSubscriptionServer.stop();
    this._httpServer.close();
  }
  get url() {
    return {
      graphql: this._url,
    };
  }
}
