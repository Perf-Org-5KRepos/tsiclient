import * as d3 from 'd3';
import { Component } from "./../../Interfaces/Component";
import { PlaybackControls } from '../PlaybackControls/PlaybackControls';
import { ServerClient } from '../../../ServerClient/ServerClient';
import { TsqRange } from '../../Models/TsqRange';
import { TsqExpression } from '../../Models/TsqExpression';

type d3Selection = d3.Selection<d3.BaseType, unknown, null, undefined>;

export interface GraphicInfo {
  graphic: any;
  width: number;
  height: number;
}

abstract class HistoryPlayback extends Component {
  protected targetElement: d3Selection;
  protected tsqExpressions: Array<TsqExpression>;
  protected componentContainer: d3Selection;
  protected component: d3Selection;
  protected playbackControlsContainer: d3Selection;
  protected playbackControls: PlaybackControls;
  protected graphicOriginalWidth: number;
  protected graphicOriginalHeight: number;
  protected serverClient: ServerClient;
  protected currentCancelTrigger: Function;
  protected availabilityInterval: number;
  protected environmentFqdn: string;
  protected availability: TsqRange;
  protected getAuthToken: () => Promise<string>;
  protected playbackRate: number;
  protected graphic: any;

  readonly numberOfBuckets = 1000;
  readonly defaultPlaybackRate = 3000; // 3 seconds
  readonly fetchAvailabilityFrequency = 30000; // 30 seconds
  readonly playbackSliderHeight = 88;
  readonly previewApiFlag = '?api-version=2018-11-01-preview';

  constructor(renderTarget: Element){ 
    super(renderTarget); 
    this.serverClient = new ServerClient();
    this.currentCancelTrigger = null;
  }

  protected abstract loadGraphic(graphicSrc: string): Promise<GraphicInfo>;
  protected abstract updateDataMarkers(data: Array<any>): void;
  protected onGraphicLoaded(): void { }

  protected renderBase(environmentFqdn: string, 
    getToken: () => Promise<string>, 
    graphicSrc: string, 
    data: Array<TsqExpression>, 
    chartOptions) {
    this.environmentFqdn = environmentFqdn;
    this.getAuthToken = getToken;
    this.tsqExpressions = data;
    this.chartOptions.setOptions(chartOptions);
    this.playbackRate = this.chartOptions.updateInterval || this.defaultPlaybackRate;

    this.getAuthToken().then((authToken: string) => {
      this.serverClient.getAvailability(authToken, this.environmentFqdn, this.previewApiFlag)
        .then(availabilityResponse => {

          if (!this.availabilityInterval) {
            this.availabilityInterval = window.setInterval(this.pollAvailability.bind(this), this.fetchAvailabilityFrequency);
          }

          let { from, to } = this.parseAvailabilityResponse(availabilityResponse);
          this.updateAvailability(from, to);

          this.targetElement = d3.select(this.renderTarget);
          this.targetElement.html('');
          this.targetElement.classed('tsi-process-graphic-target', true);
          super.themify(this.targetElement, this.chartOptions.theme);

          this.componentContainer = this.targetElement
            .append('div')
            .classed('tsi-process-graphic-container', true);

          this.component = this.componentContainer
            .append('div')
            .classed('tsi-process-graphic', true);

          this.playbackControlsContainer = this.targetElement
            .append('div')
            .classed('tsi-playback-controls-container', true);

          this.loadGraphic(graphicSrc).then((graphicInfo: GraphicInfo) => {
            this.graphic = graphicInfo.graphic;
            this.graphicOriginalWidth = graphicInfo.width;
            this.graphicOriginalHeight = graphicInfo.height;

            this.onGraphicLoaded();

            let initialTimeStamp = this.chartOptions.initialValue instanceof Date ? this.chartOptions.initialValue : from;
            this.playbackControls = new PlaybackControls(<any>this.playbackControlsContainer.node(), initialTimeStamp);

            this.onSelecTimestamp(initialTimeStamp);
          
            this.draw();

            window.addEventListener('resize', () => {
              this.draw();
            });
          });
        })
        .catch(reason => {
          console.error(`Failed while fetching data availability: ${reason}`);
        });
    })
    .catch(reason => {
      console.error(`Failed to acquire authentication token: ${reason}`);
    });
  }

  pauseAvailabilityUpdates() {
    if(this.availabilityInterval) {
      window.clearInterval(this.availabilityInterval);
    }
  }

  private async pollAvailability(): Promise<boolean> {
    return this.getAuthToken().then((authToken: string) => {
      return this.serverClient.getAvailability(authToken, this.environmentFqdn, this.previewApiFlag)
        .then(availabilityResponse => {
          let { from, to } = this.parseAvailabilityResponse(availabilityResponse);

          if (from.valueOf() !== this.availability.fromMillis || 
            to.valueOf() !== this.availability.toMillis) {
            this.updateAvailability(from, to);

            this.playbackControls.render(
              this.availability.from,
              this.availability.to,
              this.onSelecTimestamp.bind(this),
              this.chartOptions, 
              { intervalMillis: this.playbackRate, stepSizeMillis: this.availability.bucketSizeMillis });
            
            return true;
          }

          return false;
        })
        .catch(reason => {
          console.error(`Failed to update data availability: ${reason}`);
        });
    });
  }

  private onSelecTimestamp(timeStamp: Date) {
    let queryWindow = this.calcQueryWindow(timeStamp);

    let tsqArray = this.tsqExpressions.map(tsqExpression => {
      tsqExpression.searchSpan = { 
        from: queryWindow.fromMillis, 
        to: queryWindow.toMillis, 
        bucketSize: queryWindow.bucketSize };
      return tsqExpression.toTsq();
    });

    this.getAuthToken().then((authToken: string) => {
      let [promise, cancelTrigger] = this.serverClient.getCancellableTsqResults(authToken, this.environmentFqdn, tsqArray);

      // We keep track of the last AJAX call we made to the server, and cancel it if it hasn't finished yet. This is
      // a cheap way to avoid a scenario where we get out-of-order responses back from the server during 'play' mode.
      // We can revisit this at a later time if we need to handle it in a more sophisticated way.
      if (this.currentCancelTrigger) {
        this.currentCancelTrigger();
      }

      this.currentCancelTrigger = <Function>cancelTrigger;

      (promise as Promise<any>).then(results => {
        let dataPoints = results.map((r, i): IProcessGraphicLabelInfo => {
          let value = this.parseTsqResponse(r);
          let color = typeof(this.tsqExpressions[i].color) === 'function'
            ? (<Function>this.tsqExpressions[i].color)(value)
            : this.tsqExpressions[i].color;

          return {
            value,
            alias: this.tsqExpressions[i].alias,
            x: this.tsqExpressions[i].positionX,
            y: this.tsqExpressions[i].positionY,
            color: this.sanitizeAttribute(color),
            onClick: this.tsqExpressions[i].onElementClick
          };
        });

        this.updateDataMarkers(dataPoints);
      }); 
    });
  }

  private calcQueryWindow(timeStamp: Date) {
    let timelineOffset = this.availability.fromMillis;
    let queryToMillis: number = Math.ceil((timeStamp.valueOf() - timelineOffset) / this.availability.bucketSizeMillis) * this.availability.bucketSizeMillis + timelineOffset;

    return {
      fromMillis: queryToMillis - this.availability.bucketSizeMillis,
      toMillis: queryToMillis,
      bucketSize: this.availability.bucketSizeStr
    }
  }

  private draw() {
    let graphicContainerWidth = this.renderTarget.clientWidth;
    let graphicContainerHeight = this.renderTarget.clientHeight - this.playbackSliderHeight;

    this.componentContainer
      .style('width', `${graphicContainerWidth}px`)
      .style('height', `${graphicContainerHeight}px`);

    let resizedImageDim = this.getResizedImageDimensions(
      graphicContainerWidth,
      graphicContainerHeight,
      this.graphicOriginalWidth,
      this.graphicOriginalHeight);

    this.component
      .style('width', `${resizedImageDim.width}px`)
      .style('height', `${resizedImageDim.height}px`);

    this.playbackControlsContainer
      .style('width', `${this.renderTarget.clientWidth}px`)
      .style('height', `${this.playbackSliderHeight}px`);

    this.playbackControls.render(
      this.availability.from,
      this.availability.to,
      this.onSelecTimestamp.bind(this),
      this.chartOptions, 
      { intervalMillis: this.playbackRate, stepSizeMillis: this.availability.bucketSizeMillis });
  }

  private getResizedImageDimensions(containerWidth: number, containerHeight: number, imageWidth: number, imageHeight: number) {
    if (containerWidth >= imageWidth && containerHeight >= imageHeight) {
      return {
        width: imageWidth,
        height: imageHeight
      }
    }

    // Calculate the factor we would need to multiply width by to make it fit in the container.
    // Do the same for height. The smallest of those two corresponds to the largest size reduction
    // needed. Multiply both width and height by the smallest factor to a) ensure we maintain the
    // aspect ratio of the image b) ensure the image fits inside the container.
    let widthFactor = containerWidth / imageWidth;
    let heightFactor = containerHeight / imageHeight;
    let resizeFactor = Math.min(widthFactor, heightFactor);

    return {
      width: imageWidth * resizeFactor,
      height: imageHeight * resizeFactor
    }
  }

  private updateAvailability(from: Date, to: Date) {
    this.availability = new TsqRange(from, to);

    if(this.chartOptions.bucketSizeMillis && this.chartOptions.bucketSizeMillis > 0) {
      this.availability.setNeatBucketSizeByRoughBucketSize(this.chartOptions.bucketSizeMillis);
    } else {
      this.availability.setNeatBucketSizeByNumerOfBuckets(this.numberOfBuckets);
    }

    this.availability.alignWithServerEpoch();
  }

  private parseAvailabilityResponse(response) {
    let range = response && response.availability && response.availability.range;
    let from = (range && range.from && new Date(range.from)) || null;
    let to = (range && range.to && new Date(range.to)) || null;

    if (from === null || to === null) {
      throw 'Query to get availability returned a response with an unexpected structure';
    }

    return { from, to };
  }

  private parseTsqResponse(response) {
    return (response && response.properties && response.properties[0] && response.properties[0].values) 
      ? response.properties[0].values[0] 
      : null;
  }

  private sanitizeAttribute(str) {
    let sanitized = String(str);
    let illegalChars = ['"', "'", '?', '<', '>', ';'];
    illegalChars.forEach(c => { sanitized = sanitized.split(c).join('') });

    return sanitized;
  }
}

interface IProcessGraphicLabelInfo {
  value: number,
  alias: string,
  x: number,
  y: number,
  color: string,
  onClick: Function
}

export { HistoryPlayback };