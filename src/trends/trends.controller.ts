import { Controller, Get, Param, Query, ParseIntPipe } from '@nestjs/common';
import { TrendsPipelineService } from './trends-pipeline.service';
import { TrendsQueryService } from './trends-query.service';
import { GetTrendsQueryDto } from './dto/get-trends-query.dto';

@Controller('api')
export class TrendsController {
  constructor(
    private readonly trendsQueryService: TrendsQueryService,
    private readonly trendsPipelineService: TrendsPipelineService,
  ) {}

  // 트렌드 목록 / 검색 공통 진입점
  @Get('trends')
  getTrends(@Query() query: GetTrendsQueryDto) {
    return this.trendsQueryService.getTrends(query);
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