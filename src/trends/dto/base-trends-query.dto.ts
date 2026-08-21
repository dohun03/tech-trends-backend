import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class BaseTrendsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page는 정수여야 합니다.' })
  @Min(1, { message: 'page는 최소 1 이상이어야 합니다.' })
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit는 정수여야 합니다.' })
  @Min(1, { message: 'limit는 최소 1 이상이어야 합니다.' })
  @Max(100, { message: 'limit는 최대 100까지 설정할 수 있습니다.' })
  limit?: number = 5;

  @IsOptional()
  @IsString()
  source?: string = 'ALL';

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  isNew?: boolean = false;
}