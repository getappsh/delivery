import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrepareDeliveryResDto } from '@app/common/dto/delivery';
import * as semver from 'semver';
import { MicroserviceClient, MicroserviceName } from '@app/common/microservice-client';
import { DeviceTopics } from '@app/common/microservice-client/topics';
import { lastValueFrom } from 'rxjs';
import { DeviceComponentStateEnum } from '@app/common/database/entities';

const AGENT_PROJECT_NAMES = [
  'GetAppAgent-Services',
  'GetAppAgent-Services_linux_rpm'
];

const OLD_AGENT_MAX_VERSION = '0.3.25';

@Injectable()
export class AgentCompatibilityService implements OnModuleInit {
  private readonly logger = new Logger(AgentCompatibilityService.name);

  constructor(
    @Inject(MicroserviceName.DISCOVERY_SERVICE) private readonly deviceClient: MicroserviceClient,
  ) {}

  async onModuleInit() {
    this.deviceClient.subscribeToResponseOf([DeviceTopics.DEVICE_SOFTWARES]);
    await this.deviceClient.connect();
  }

  /**
   * Applies old-agent compatibility transformations to a delivery response.
   * For agents running version <= 0.3.25, MSI/RPM artifacts with isExecutable=true
   * won't be routed to the correct deployer. We set isExecutable=false so the old
   * agent falls back to extension-based deployer selection.
   */
  async applyCompatibility(res: PrepareDeliveryResDto, deviceId: string): Promise<void> {
    if (!res.Artifacts || res.Artifacts.length === 0 || !deviceId) return;

    // Check if any artifact has isExecutable=true with .msi/.rpm extension
    const hasMsiRpmExecutable = res.Artifacts.some(art => {
      if (!art.isExecutable) return false;
      const key = art.itemKey || '';
      const ext = key.substring(key.lastIndexOf('.')).toLowerCase();
      return ext === '.msi' || ext === '.rpm';
    });
    if (!hasMsiRpmExecutable) return;

    // Get the device's installed agent version via discovery service
    const agentVersion = await this.getDeviceAgentVersion(deviceId);
    if (!agentVersion) {
      this.logger.debug(`No installed agent version found for device ${deviceId}, skipping compatibility check`);
      return;
    }

    const coercedVersion = semver.coerce(agentVersion);
    if (!coercedVersion || !semver.lte(coercedVersion, OLD_AGENT_MAX_VERSION)) {
      this.logger.debug(`Device ${deviceId} agent version ${agentVersion} is newer than ${OLD_AGENT_MAX_VERSION}, no compatibility needed`);
      return;
    }

    this.logger.log(`Device ${deviceId} has old agent version ${agentVersion} (<= ${OLD_AGENT_MAX_VERSION}), applying artifact compatibility`);

    for (const artifact of res.Artifacts) {
      if (!artifact.isExecutable) continue;
      const key = artifact.itemKey || '';
      const ext = key.substring(key.lastIndexOf('.')).toLowerCase();
      if (ext === '.msi' || ext === '.rpm') {
        this.logger.log(`Setting isExecutable=false for artifact "${key}" (old agent compatibility)`);
        artifact.isExecutable = false;
      }
    }
  }

  private async getDeviceAgentVersion(deviceId: string): Promise<string | null> {
    try {
      const deviceSoftwares = await lastValueFrom(
        this.deviceClient.send(DeviceTopics.DEVICE_SOFTWARES, { deviceId })
      );
      if (!deviceSoftwares?.softwares) return null;

      const agentSoftware = deviceSoftwares.softwares
        .filter((s: any) =>
          s.state === DeviceComponentStateEnum.INSTALLED &&
          AGENT_PROJECT_NAMES.includes(s.software?.projectName)
        )
        .sort((a: any, b: any) => (b.software?.version || '').localeCompare(a.software?.version || ''));

      return agentSoftware[0]?.software?.version || null;
    } catch (error) {
      this.logger.warn(`Failed to get device softwares for ${deviceId}: ${error}`);
      return null;
    }
  }
}
