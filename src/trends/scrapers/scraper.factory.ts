import { Injectable } from '@nestjs/common';
import { IArticleScraper } from '../interfaces/scraper.interface';
import { DevToScraper } from './devto.scraper';
import { GeekNewsScraper } from './geek-news.scraper';
import { StackOverflowScraper } from './stackoverflow.scraper';

@Injectable()
export class ScraperFactory {
  private readonly scraperMap: Map<string, IArticleScraper>;

  constructor(
    private readonly devToScraper: DevToScraper,
    private readonly geekNewsScraper: GeekNewsScraper,
    private readonly stackOverflowScraper: StackOverflowScraper,
  ) {
    this.scraperMap = new Map<string, IArticleScraper>([
      [this.devToScraper.sourceName, this.devToScraper],
      [this.geekNewsScraper.sourceName, this.geekNewsScraper],
      [this.stackOverflowScraper.sourceName, this.stackOverflowScraper],
    ]);
  }

  /**
   * 소스 이름에 해당하는 스크래퍼를 반환합니다.
   */
  getScraper(sourceName: string): IArticleScraper {
    const scraper = this.scraperMap.get(sourceName);
    if (!scraper) {
      throw new Error(`[ScraperFactory] 등록되지 않은 스크래퍼 소스입니다: ${sourceName}`);
    }
    return scraper;
  }

  /**
   * 등록된 모든 스크래퍼의 소스 이름을 반환합니다.
   */
  getAllSourceNames(): string[] {
    return Array.from(this.scraperMap.keys());
  }
}
