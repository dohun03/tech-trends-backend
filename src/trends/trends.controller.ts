import { Controller, Get, Param, Query, ParseIntPipe } from '@nestjs/common';
import { TrendsPipelineService } from './services/trends-pipeline.service';
import { ListTrendsQueryDto } from './dto/list-trends-query.dto';
import { TrendsQueryService } from './services/trends-query.service';
import { Throttle } from '@nestjs/throttler';
import { SearchTrendsQueryDto } from './dto/search-trends-query.dto';

@Controller('api')
export class TrendsController {
  constructor(
    private readonly trendsQueryService: TrendsQueryService,
    private readonly trendsPipelineService: TrendsPipelineService,
  ) {}

  // 트렌드 목록
  @Get('trends')
  getTrends(@Query() query: ListTrendsQueryDto) {
    return this.trendsQueryService.listTrends(query);
  }

  // 검색
  @Throttle({ default: { limit: 5, ttl: 10000 } })
  @Get('trends/search')
  searchTrends(@Query() query: SearchTrendsQueryDto) {
    return this.trendsQueryService.searchTrends(query);
  }

  // 출처 목록 조회
  @Get('trends/sources')
  async getSources() {
    return this.trendsQueryService.getUniqueSources();
  }

  // 단일 아티클 조회
  @Get('trends/:id')
  getTrendById(@Param('id') id: number) {
    return this.trendsQueryService.getTrendById(id);
  }

  // 스크래핑 테스트용 엔드포인트
  @Get('test-scraping')
  async runScrapingTest() {
    await this.trendsPipelineService.dispatchAllScrapersToQueue();

    return {
      success: true,
      message: '백엔드 터미널 콘솔을 확인해보세요!',
    };
  }
}