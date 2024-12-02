import { PrepareDeliveryReqDto, PrepareDeliveryResDto, DeliveryStatusDto } from "@app/common/dto/delivery";
import { TokensDto } from "@app/common/dto/login/dto/tokens.dto";
import { HttpConfigService } from "@app/common/utils/http-config.service";
import { API, DeliveryEndpoints } from "@app/common/utils/paths";
import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AxiosResponse } from "axios";
import * as stream from 'stream';

const REQUEST_TIME_OUT = 10000;

@Injectable()
export class HttpClientService {
  private readonly logger = new Logger(HttpClientService.name);

  private httpService: HttpService;

  constructor(
    httpConfig: HttpConfigService,
  ) {
    this.httpService = httpConfig.httpService
  }

  async apiPrepareDelivery(prepDlv: PrepareDeliveryReqDto): Promise<PrepareDeliveryResDto> {
    this.logger.debug(`Get download url for catalogId ${prepDlv.catalogId}`);
    const url = `${DeliveryEndpoints.preparedDelivery}`;
    return (await this.httpService.axiosRef.post(url, prepDlv)).data;
  }

  async apiUpdateDeliveryStatus(dlvStatus: DeliveryStatusDto) {
    this.logger.debug(`Update delivery status. cataloId: ${dlvStatus.catalogId}, status: ${dlvStatus.deliveryStatus}`);
    const url = `${DeliveryEndpoints.updateDownloadStatus}`;
    return (await this.httpService.axiosRef.post(url, dlvStatus)).data;
  }


  // apiGetPreparedDelivery(){
  // }


  async downloadFileToStream(outputStream: stream.Writable, url: string, catalogId: string): Promise<AxiosResponse> {
    this.httpService.axiosRef.defaults.baseURL = ''
    this.httpService.axiosRef.defaults.httpsAgent = undefined
    const response = await this.httpService.axiosRef.get(url, { responseType: 'stream', timeout: REQUEST_TIME_OUT });
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
        this.logger.verbose(`Downloading... ${progress.toFixed(2)}%, of catalogId: ${catalogId}`);
      }

    });
    response.data.on('error', (err: any) => {
      this.logger.error(`Error downloading catalogId ${catalogId} from url ${url}, ${err}`);
      outputStream.destroy(err)
    });

    return response;
  }
}