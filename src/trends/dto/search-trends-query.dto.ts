import { IsNotEmpty, IsString, IsOptional, IsIn } from 'class-validator';
import { BaseTrendsQueryDto } from './base-trends-query.dto';

export class SearchTrendsQueryDto extends BaseTrendsQueryDto {
  @IsString({ message: '검색어는 문자열이어야 합니다.' })
  @IsNotEmpty({ message: '검색어를 입력해 주세요.' })
  search!: string;

  @IsOptional()
  @IsIn(['hybrid', 'keyword'], { message: '검색 타입은 hybrid 또는 keyword 이어야 합니다.' })
  searchType?: 'hybrid' | 'keyword';
}