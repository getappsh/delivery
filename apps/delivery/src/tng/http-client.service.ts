import { PrepareDeliveryReqDto, PrepareDeliveryResDto, DeliveryStatusDto } from "@app/common/dto/delivery";
import { ProxyHttpConfigService } from "@app/common/http-config/http-config.service";
import { DeliveryEndpoints } from "@app/common/utils/paths";
import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { AxiosResponse } from "axios";
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

  async apiPrepareDelivery(prepDlv: PrepareDeliveryReqDto): Promise<PrepareDeliveryResDto> {
    this.logger.debug(`Get download url for catalogId ${prepDlv.catalogId}`);
    const url = `${DeliveryEndpoints.preparedDelivery}`;
    return (await this.httpService.axiosRef.post(url, prepDlv)).data;
  }
  
  async apiGetPreparedDelivery(catalogId: string): Promise<PrepareDeliveryResDto> {
    this.logger.debug(`Get status for download url for catalogId: ${catalogId}`);
    const url = `${DeliveryEndpoints.getPreparedByCatalogId}${catalogId}`;
    return (await this.httpService.axiosRef.get(url)).data;
  }
  
  async getMapJson(url: string): Promise<any> {
    this.logger.debug(`download json from url ${url}`);
    return (await this.httpService.axiosRef.get(url)).data;
  }
}