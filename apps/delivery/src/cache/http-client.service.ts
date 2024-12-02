import { DeliveryStatusDto } from "@app/common/dto/delivery";
import { DeliveryError } from "@app/common/dto/delivery/dto/delivery-error";
import { ErrorCode } from '@app/common/dto/error';
import { ProxyHttpConfigService } from "@app/common/http-config/http-config.service";
import { DeliveryEndpoints } from "@app/common/utils/paths";
import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { AxiosResponse, AxiosResponseHeaders, RawAxiosResponseHeaders } from "axios";
import * as stream from 'stream';

const REQUEST_TIME_OUT = 10000;

@Injectable()
export class HttpClientService {
  private readonly logger = new Logger(HttpClientService.name);

  private httpService: HttpService;

  constructor(
    httpConfig: ProxyHttpConfigService,
  ) {
    this.httpService = httpConfig.httpService
  }

  async apiUpdateDeliveryStatus(dlvStatus: DeliveryStatusDto) {
    this.logger.debug(`Send update delivery status. cataloId: ${dlvStatus.catalogId}, itemKey: ${dlvStatus.itemKey}, status: ${dlvStatus.deliveryStatus}`);
    const url = `${DeliveryEndpoints.updateDownloadStatus}`;
    return (await this.httpService.axiosRef.post(url, dlvStatus)).data
  }

  async getUrlHead(url: string): Promise<RawAxiosResponseHeaders | AxiosResponseHeaders> {
    return new Promise((resolve, reject) => {
      const request = this.httpService.axiosRef.get(url, {
        baseURL: "",
        httpsAgent: undefined,
        responseType: 'stream', // Use stream response type
        timeout: REQUEST_TIME_OUT,
      });

      request.then(response => {
        const headers = response.headers;
        response.data.destroy();
        resolve(headers);
      }).catch(error => {
        if (error?.response?.status == 404) {
          const inValidErr = new DeliveryError(ErrorCode.DLV_C_INVALID, error.message)
          reject(inValidErr)
        } else {
          reject(error)
        }
      });
    });
  }

  async downloadFileToStream(outputStream: stream.Writable, url: string, catalogId: string, itemKey: string): Promise<AxiosResponse> {

    const controller = new AbortController();
    const { signal } = controller;

    const response = await this.httpService.axiosRef.get(url, { baseURL: "", httpsAgent: undefined, responseType: 'stream', timeout: REQUEST_TIME_OUT, signal });
    response.data.pipe(outputStream)

    const totalLength = response.headers['content-length'];
    let downloadedLength = 0;
    let lastLogTime = Date.now();

    response.data.on('data', (chunk: any) => {
      downloadedLength += chunk.length;
      let currentLogTime = Date.now();

      if (currentLogTime - lastLogTime > 5000) {
        lastLogTime = currentLogTime;
        const progress = (downloadedLength / totalLength) * 100;
        this.logger.verbose(`Downloading... ${progress.toFixed(2)}%, of catalogId: ${catalogId} with item id: ${itemKey}`);
      }

    });
    response.data.on('error', (err: any) => {
      this.logger.error(`Error downloading catalogId ${catalogId} - item ${itemKey}, ${err}`);
      this.logger.verbose(`Error downloading catalogId ${catalogId} - item ${itemKey} from url ${url}, ${err}`);
      outputStream.destroy(err)
    });

    outputStream.on("close", () => {
      controller.abort()
    })

    return response;
  }
}