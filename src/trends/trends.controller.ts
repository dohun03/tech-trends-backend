import { Controller, Get, Query } from '@nestjs/common';
import { TrendsPipelineService } from 'trends/trends-pipeline.service';
import { TrendsQueryService } from './trends-query.service';
import { GetTrendsQueryDto } from './dto/get-trends-query.dto';

@Controller('api')
export class TrendsController {
  constructor(
    private readonly trendsQueryService: TrendsQueryService,
    private readonly trendsPipelineService: TrendsPipelineService,
  ) {}

  @Get('trends')
  getTrends(@Query() query: GetTrendsQueryDto) {
    return this.trendsQueryService.getTrends(query);
  }

  @Get('trends/sources')
  async getSources() {
    return this.trendsQueryService.getUniqueSources();
  }

  @Get('test-scraping')
  async triggerScrapingTest() {
    await this.trendsPipelineService.collectAndProcessTrends();
    
    return {
      success: true,
      message: '백엔드 터미널 콘솔을 확인해보세요! 벨로그 데이터가 찍히고 있을 겁니다.',
    };
  }
}