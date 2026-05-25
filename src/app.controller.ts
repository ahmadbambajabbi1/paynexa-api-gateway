import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  root(): { service: string; status: string } {
    return { service: 'api-gateway', status: 'ok' };
  }

  @Get('health')
  health(): { service: string; status: string } {
    return { service: 'api-gateway', status: 'ok' };
  }
}
