import { DeliveryError } from "@app/common/dto/delivery/dto/delivery-error";
import { ErrorCode } from "@app/common/dto/error";
import { ProxyHttpConfigService } from "@app/common/http-config/http-config.service";
import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";

@Injectable()
export class HttpClientService {
  private readonly logger = new Logger(HttpClientService.name);

  private httpService: HttpService;

  constructor(
    httpConfig: ProxyHttpConfigService,
  ) {
    this.httpService = httpConfig.httpService
  }

  async getMapJson(url: string): Promise<any> {
    this.logger.debug(`download json from url ${url}`);
    try {
      return (await this.httpService.axiosRef.get(url)).data;
    } catch (error) {
      if (error?.response?.status == 404) {
        const inValidErr = new DeliveryError(ErrorCode.DLV_C_INVALID, error.message)
        throw inValidErr
      } else {
        throw error
      }
    }
  }
}