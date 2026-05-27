import { DeliveryError } from "@app/common/dto/delivery/dto/delivery-error";
import { ErrorCode } from "@app/common/dto/error";
import { PrepareDeliveryResDto } from "@app/common/dto/delivery";
import { ProxyHttpConfigService } from "@app/common/http-config/http-config.service";
import { HttpService } from "@nestjs/axios";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import axios, { AxiosInstance } from "axios";

@Injectable()
export class HttpClientService {
  private readonly logger = new Logger(HttpClientService.name);

  private httpService: HttpService;
  // TEMPORARY: Dedicated HTTP client for GetMap server delivery fallback.
  // Needed while GetMap runs as a separate deployment with its own DB/MinIO.
  // TODO: Remove once GetMap is fully integrated into GetApp server.
  private getmapClient: AxiosInstance | null = null;

  constructor(
    httpConfig: ProxyHttpConfigService,
    configService: ConfigService,
  ) {
    this.httpService = httpConfig.httpService

    // TEMPORARY: GetMap fallback client
    const getmapServerUrl = configService.get<string>("GETMAP_SERVER_URL");
    if (getmapServerUrl) {
      const deviceSecret = configService.get<string>("DEVICE_SECRET");
      this.getmapClient = axios.create({
        baseURL: getmapServerUrl.replace(/\/+$/, ''),
        timeout: 30000,
        headers: deviceSecret ? { "device-auth": deviceSecret } : {},
      });
      this.logger.log(`GetMap delivery fallback configured, target: ${getmapServerUrl}`);
    }
  }

  get isGetmapFallbackEnabled(): boolean {
    return this.getmapClient !== null;
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

  /**
   * Forward a prepareDelivery request to the GetMap server.
   * Used as a fallback when catalogId is not found in local DB (neither in releases nor maps).
   */
  async getmapPrepareDelivery(catalogId: string, deviceId: string, itemType: string): Promise<PrepareDeliveryResDto> {
    this.logger.log(`GetMap fallback: prepareDelivery for catalogId ${catalogId}`);
    const res = await this.getmapClient.post(`/api/v1/delivery/prepareDelivery`, { catalogId, deviceId, itemType });
    return res.data;
  }

  /**
   * Poll the GetMap server for prepared delivery status.
   */
  async getmapGetPreparedDelivery(catalogId: string): Promise<PrepareDeliveryResDto> {
    this.logger.debug(`GetMap fallback: getPreparedDelivery for catalogId ${catalogId}`);
    const res = await this.getmapClient.get(`/api/v1/delivery/preparedDelivery/${catalogId}`);
    return res.data;
  }
}