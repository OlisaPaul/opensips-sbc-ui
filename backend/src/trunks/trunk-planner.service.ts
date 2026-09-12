import { Injectable } from '@nestjs/common';
import { TrunkInputDto } from './dto';
import { PlannedAction, ProvisionPlan } from './trunk.types';

@Injectable()
export class TrunkPlannerService {
  build(input: TrunkInputDto): ProvisionPlan {
    const providerSet = input.providerDispatcherSet ?? 1;
    const applicationSet = input.applicationDispatcherSet ?? 8;
    const providerSocket = `sip:${input.providerIp}:${input.providerPort}`;
    const applicationSocket = `sip:${input.applicationIp}:${input.applicationPort}`;
    const registrar = input.registrationServer?.trim() || providerSocket;
    const warnings: string[] = [];

    if (!input.password && input.registrationEnabled) {
      warnings.push('Registration is enabled but no password was supplied. Existing credentials will be kept on edit, but create needs a password.');
    }

    const actions: PlannedAction[] = [
      {
        label: 'Save trunk metadata',
        sql: 'insert/update sbc_trunks',
        params: this.safeParams(input, providerSet, applicationSet),
      },
      {
        label: 'Provision provider dispatcher gateway',
        sql: 'insert/update dispatcher(setid, destination, description)',
        params: { setid: providerSet, destination: providerSocket, description: input.name },
      },
      {
        label: 'Authorize provider source address',
        sql: 'insert/update address(grp=1, ip, port, pattern)',
        params: { grp: 1, ip: input.providerIp, port: input.providerPort, pattern: input.pilotCli },
      },
      {
        label: 'Map DID to application dispatcher set',
        sql: 'insert/update did_mapping(did, dispatcher_set, application_name)',
        params: { did: input.username, dispatcher_set: applicationSet, application_name: input.applicationName },
      },
      {
        label: 'Provision application dispatcher gateway',
        sql: 'insert/update dispatcher(setid, destination, description)',
        params: { setid: applicationSet, destination: applicationSocket, description: input.applicationName },
      },
      {
        label: 'Authorize application/PBX source address',
        sql: 'insert/update address(grp=2, ip, port, pattern)',
        params: { grp: 2, ip: input.applicationIp, port: input.applicationPort, pattern: input.pilotCli },
      },
      {
        label: 'Map outbound prefix to provider dispatcher set',
        sql: 'insert/update prefix_mapping(prefix, strip_prefix, dispatcher_set, pilot_cli)',
        params: {
          prefix: input.accessPrefix,
          strip_prefix: input.stripPrefix,
          dispatcher_set: providerSet,
          pilot_cli: input.pilotCli,
        },
      },
      {
        label: 'Reload OpenSIPS address and dispatcher data',
        mi: 'address_reload, ds_reload',
      },
    ];

    if (input.registrationEnabled) {
      actions.splice(1, 0, {
        label: 'Provision REGISTER account',
        sql: 'insert/update registrant(username, password, registrar, proxy)',
        params: {
          username: input.username,
          password: '********',
          registrar,
          proxy: providerSocket,
        },
      });
    }

    return {
      summary: [
        `${input.name}: ${input.username} via ${providerSocket}`,
        `Inbound ${input.username} -> ${input.applicationName} (${applicationSocket})`,
        `Outbound ${input.accessPrefix} -> dispatcher set ${providerSet}`,
      ],
      actions,
      warnings,
    };
  }

  private safeParams(input: TrunkInputDto, providerSet: number, applicationSet: number) {
    const { password: _password, ...safe } = input;
    return { ...safe, providerDispatcherSet: providerSet, applicationDispatcherSet: applicationSet };
  }
}
