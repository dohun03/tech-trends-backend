import { Controller, Get, Query } from '@nestjs/common';
import { ApiService } from './api.service';
import { TrendsService } from 'trends/trends.service';

@Controller('api')
export class ApiController {
  constructor(
    private readonly apiService: ApiService,
    private readonly trendsService: TrendsService,
  ) {}

  @Get('trends')
  getTrends(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('search') search?: string,
    @Query('source') source?: string,
    @Query('sort') sort?: 'ASC' | 'DESC',
  ) {
    return this.apiService.getTrends({ page, limit, search, source, sort });
  }

  @Get('test-scraping')
  async triggerScrapingTest() {
    await this.trendsService.collectAndProcessTrends();
    
    return {
      success: true,
      message: '백엔드 터미널 콘솔을 확인해보세요! 벨로그 데이터가 찍히고 있을 겁니다.',
    };
  }
}