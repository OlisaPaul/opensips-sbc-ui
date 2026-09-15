import { Injectable } from '@nestjs/common';
import { TrunkInputDto } from './dto';
import { PlannedAction, ProvisionPlan } from './trunk.types';

@Injectable()
export class TrunkPlannerService {
  build(input: TrunkInputDto): ProvisionPlan {
    const providerSet = input.providerDispatcherSet;
    const providerSocket = `sip:${input.providerIp}:${input.providerPort}`;
    const registrar = input.registrationServer?.trim() || providerSocket;
    const warnings: string[] = [];

    if (!input.password && input.registrationEnabled) {
      warnings.push('Registration is enabled but no password was supplied. Existing credentials will be kept on edit, but create needs a password.');
    }

    const actions: PlannedAction[] = [
      {
        label: 'Save trunk metadata',
        sql: 'insert/update sbc_trunks',
        params: this.safeParams(input, providerSet),
      },
      {
        label: 'Provision provider dispatcher gateway',
        sql: 'insert/update dispatcher(setid, destination, description)',
        params: { setid: providerSet, destination: providerSocket, description: input.name },
      },
      {
        label: 'Authorize provider source address',
        sql: 'insert/update address(grp=1, ip, port, pattern)',
        params: { grp: 1, ip: input.providerIp, port: input.providerPort, pattern: input.username },
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
          expiry: input.registrationExpiry ?? 3600,
        },
      });
    }

    return {
      summary: [
        `${input.name}: ${input.username} via ${providerSocket}`,
        `Provider dispatcher set ${providerSet}`,
        'Inbound and outbound routes are managed separately.',
      ],
      actions,
      warnings,
    };
  }

  private safeParams(input: TrunkInputDto, providerSet: number) {
    const { password: _password, ...safe } = input;
    return { ...safe, providerDispatcherSet: providerSet };
  }
}
