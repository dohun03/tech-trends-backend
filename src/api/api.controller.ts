import { Controller, Get, Query } from '@nestjs/common';
import { ApiService } from './api.service';

@Controller('api/trends')
export class ApiController {
  constructor(private readonly apiService: ApiService) {}

  @Get()
  getTrends(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
    @Query('source') source?: string,
    @Query('sort') sort?: 'ASC' | 'DESC',
  ) {
    return this.apiService.getTrends({ page, limit, search, source, sort });
  }
}