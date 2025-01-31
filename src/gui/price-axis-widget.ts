import { ensureNotNull } from '../helpers/assertions';
import { getContext2d } from '../helpers/canvas-wrapper';
import { IDestroyable } from '../helpers/idestroyable';
import { makeFont } from '../helpers/make-font';

import { Coordinate } from '../model/coordinate';
import { IDataSource } from '../model/idata-source';
import { InvalidationLevel } from '../model/invalidate-mask';
import { LayoutOptions } from '../model/layout-options';
import { PriceScalePosition } from '../model/pane';
import { PriceScale } from '../model/price-scale';
import { TextWidthCache } from '../model/text-width-cache';
import { PriceAxisViewRendererOptions } from '../renderers/iprice-axis-view-renderer';
import { PriceAxisRendererOptionsProvider } from '../renderers/price-axis-renderer-options-provider';
import { IPriceAxisView } from '../views/price-axis/iprice-axis-view';

import { addCanvasTo, clearRect, resizeCanvas, Size } from './canvas-utils';
import { LabelsImageCache } from './labels-image-cache';
import { MouseEventHandler, MouseEventHandlers, TouchMouseEvent } from './mouse-event-handler';
import { PaneWidget } from './pane-widget';

export type PriceAxisWidgetSide = Exclude<PriceScalePosition, 'overlay'>;

const enum CursorType {
	Default,
	NsResize,
}

type IPriceAxisViewArray = ReadonlyArray<IPriceAxisView>;

export class PriceAxisWidget implements IDestroyable {
	private readonly _pane: PaneWidget;
	private readonly _options: LayoutOptions;
	private readonly _rendererOptionsProvider: PriceAxisRendererOptionsProvider;
	private readonly _isLeft: boolean;

	private _priceScale: PriceScale | null = null;

	private _size: Size | null = null;

	private readonly _cell: HTMLDivElement;
	private readonly _canvas: HTMLCanvasElement;
	private readonly _ctx: CanvasRenderingContext2D;
	private readonly _topCanvas: HTMLCanvasElement;
	private readonly _topCtx: CanvasRenderingContext2D;

	private _updateTimeout: number | null = null;
	private _mouseEventHandler: MouseEventHandler;
	private _mousedown: boolean = false;

	private _isVisible: boolean = true;

	private readonly _widthCache: TextWidthCache = new TextWidthCache(50);
	private _tickMarksCache: LabelsImageCache = new LabelsImageCache(11, '#000');

	private _color: string | null = null;
	private _font: string | null = null;
	private _prevOptimalWidth: number = 0;

	public constructor(pane: PaneWidget, options: LayoutOptions, rendererOptionsProvider: PriceAxisRendererOptionsProvider, side: PriceAxisWidgetSide) {
		this._pane = pane;
		this._options = options;
		this._rendererOptionsProvider = rendererOptionsProvider;
		this._isLeft = side === 'left';

		this._cell = document.createElement('div');
		this._cell.style.height = '100%';
		this._cell.style.overflow = 'hidden';
		this._cell.style.width = '25px';
		this._cell.style.left = '0';
		this._cell.style.position = 'relative';

		this._canvas = addCanvasTo(this._cell, new Size(16, 16));
		this._canvas.style.position = 'absolute';
		this._canvas.style.zIndex = '1';
		this._canvas.style.left = '0';
		this._canvas.style.top = '0';

		this._ctx = ensureNotNull(getContext2d(this._canvas));

		this._topCanvas = addCanvasTo(this._cell, new Size(16, 16));
		this._topCanvas.style.position = 'absolute';
		this._topCanvas.style.zIndex = '2';
		this._topCanvas.style.left = '0';
		this._topCanvas.style.top = '0';

		this._topCtx = ensureNotNull(getContext2d(this._topCanvas));

		const handler: MouseEventHandlers = {
			mouseDownEvent: this._mouseDownEvent.bind(this),
			pressedMouseMoveEvent: this._pressedMouseMoveEvent.bind(this),
			mouseDownOutsideEvent: this._mouseDownOutsideEvent.bind(this),
			mouseUpEvent: this._mouseUpEvent.bind(this),
			mouseDoubleClickEvent: this._mouseDoubleClickEvent.bind(this),
			mouseEnterEvent: this._mouseEnterEvent.bind(this),
			mouseLeaveEvent: this._mouseLeaveEvent.bind(this),
		};
		this._mouseEventHandler = new MouseEventHandler(
			this._topCanvas,
			handler,
			{
				treatVertTouchDragAsPageScroll: false,
				treatHorzTouchDragAsPageScroll: true,
			}
		);
	}

	public destroy(): void {
		this._mouseEventHandler.destroy();

		if (this._priceScale !== null) {
			this._priceScale.onMarksChanged().unsubscribeAll(this);
			this._priceScale.optionsChanged().unsubscribeAll(this);
		}
		this._priceScale = null;

		if (this._updateTimeout !== null) {
			clearTimeout(this._updateTimeout);
			this._updateTimeout = null;
		}

		this._tickMarksCache.destroy();
	}

	public getElement(): HTMLElement {
		return this._cell;
	}

	public backgroundColor(): string {
		return this._options.backgroundColor;
	}

	public lineColor(): string {
		return this._pane.chart().options().priceScale.borderColor;
	}

	public textColor(): string {
		return this._options.textColor;
	}

	public fontSize(): number {
		return this._options.fontSize;
	}

	public baseFont(): string {
		return makeFont(this.fontSize(), this._options.fontFamily);
	}

	public rendererOptions(): Readonly<PriceAxisViewRendererOptions> {
		const options = this._rendererOptionsProvider.options();

		const isColorChanged = this._color !== options.color;
		const isFontChanged = this._font !== options.font;

		if (isColorChanged || isFontChanged) {
			this._recreateTickMarksCache(options);
			this._color = options.color;
		}

		if (isFontChanged) {
			this._widthCache.reset();
			this._font = options.font;
		}

		return options;
	}

	public optimalWidth(): number {
		if (!this.isVisible() || this._priceScale === null) {
			return 0;
		}

		// need some reasonable value for scale while initialization
		let tickMarkMaxWidth = 34;
		const rendererOptions = this.rendererOptions();

		const ctx = this._ctx;
		const tickMarks = this._priceScale.marks();

		ctx.font = this.baseFont();

		if (tickMarks.length > 0) {
			tickMarkMaxWidth = Math.max(
				this._widthCache.measureText(ctx, tickMarks[0].label),
				this._widthCache.measureText(ctx, tickMarks[tickMarks.length - 1].label)
			);
		}

		const views = this._backLabels();
		for (let j = views.length; j--;) {
			const width = this._widthCache.measureText(ctx, views[j].text());
			if (width > tickMarkMaxWidth) {
				tickMarkMaxWidth = width;
			}
		}

		return Math.ceil(
			rendererOptions.offsetSize +
			rendererOptions.borderSize +
			rendererOptions.tickLength +
			rendererOptions.paddingInner +
			rendererOptions.paddingOuter +
			tickMarkMaxWidth
		);
	}

	public setSize(size: Size): void {
		if (size.w < 0 || size.h < 0) {
			throw new Error('Try to set invalid size to PriceAxisWidget ' + JSON.stringify(size));
		}
		if (this._size === null || !this._size.equals(size)) {
			this._size = size;

			resizeCanvas(this._canvas, size);
			resizeCanvas(this._topCanvas, size);

			this._cell.style.width = size.w + 'px';
			// need this for IE11
			this._cell.style.height = size.h + 'px';
			this._cell.style.minWidth = size.w + 'px'; // for right calculate position of .pane-legend
		}
	}

	public getWidth(): number {
		return ensureNotNull(this._size).w;
	}

	public setPriceScale(priceScale: PriceScale): void {
		if (this._priceScale === priceScale) {
			return;
		}

		if (this._priceScale !== null) {
			this._priceScale.onMarksChanged().unsubscribeAll(this);
			this._priceScale.optionsChanged().unsubscribeAll(this);
		}

		this._priceScale = priceScale;
		priceScale.onMarksChanged().subscribe(this._onMarksChanged.bind(this), this);
	}

	public priceScale(): PriceScale | null {
		return this._priceScale;
	}

	public isVisible(): boolean {
		return this._isVisible;
	}

	public setVisible(visible: boolean): void {
		if (visible === this._isVisible) {
			return;
		}
		if (visible) {
			this._cell.style.display = 'table-cell';
		} else {
			this._cell.style.display = 'none';
		}

		this._isVisible = visible;
	}

	public setAutoScale(on: boolean): void {
		const pane = this._pane.state();
		const model = this._pane.chart().model();
		model.setPriceAutoScale(pane, ensureNotNull(this.priceScale()), on);
	}

	public reset(): void {
		const pane = this._pane.state();
		const model = this._pane.chart().model();
		model.resetPriceScale(pane, ensureNotNull(this.priceScale()));
	}

	public paint(type: InvalidationLevel): void {
		if (!this._isVisible || this._size === null) {
			return;
		}

		this._topCtx.clearRect(-0.5, -0.5, this._size.w, this._size.h);

		if (type !== InvalidationLevel.Cursor) {
			this._alignLabels();
			this._drawBackground(this._ctx);
			this._drawBorder(this._ctx);
			this._drawTickMarks(this._ctx);
			this._drawBackLabels(this._ctx);
		}
		this._drawCrosshairLabel(this._topCtx);
	}

	public getImage(): HTMLCanvasElement {
		return this._canvas;
	}

	public isLeft(): boolean {
		return this._isLeft;
	}

	private _mouseDownEvent(e: TouchMouseEvent): void {
		if (this._priceScale === null || this._priceScale.isEmpty() || !this._pane.chart().options().handleScale.axisPressedMouseMove) {
			return;
		}

		const model = this._pane.chart().model();
		const pane = this._pane.state();
		this._mousedown = true;
		model.startScalePrice(pane, this._priceScale, e.localY as Coordinate);
	}

	private _pressedMouseMoveEvent(e: TouchMouseEvent): void {
		if (this._priceScale === null || !this._pane.chart().options().handleScale.axisPressedMouseMove) {
			return;
		}

		const model = this._pane.chart().model();
		const pane = this._pane.state();
		const priceScale = this._priceScale;
		model.scalePriceTo(pane, priceScale, e.localY as Coordinate);
	}

	private _mouseDownOutsideEvent(): void {
		if (this._priceScale === null || !this._pane.chart().options().handleScale.axisPressedMouseMove) {
			return;
		}

		const model = this._pane.chart().model();
		const pane = this._pane.state();

		const priceScale = this._priceScale;
		if (this._mousedown) {
			this._mousedown = false;
			model.endScalePrice(pane, priceScale);
		}
	}

	private _mouseUpEvent(e: TouchMouseEvent): void {
		if (this._priceScale === null || !this._pane.chart().options().handleScale.axisPressedMouseMove) {
			return;
		}
		const model = this._pane.chart().model();
		const pane = this._pane.state();
		this._mousedown = false;
		model.endScalePrice(pane, this._priceScale);
	}

	private _mouseDoubleClickEvent(e: TouchMouseEvent): void {
		this.reset();
	}

	private _mouseEnterEvent(e: TouchMouseEvent): void {
		if (this._priceScale === null) {
			return;
		}

		const model = this._pane.chart().model();
		if (model.options().handleScale.axisPressedMouseMove && !this._priceScale.isPercentage() && !this._priceScale.isIndexedTo100()) {
			this._setCursor(CursorType.NsResize);
		}
	}

	private _mouseLeaveEvent(e: TouchMouseEvent): void {
		this._setCursor(CursorType.Default);
	}

	private _backLabels(): IPriceAxisView[] {
		const res: IPriceAxisView[] = [];

		const priceScale = (this._priceScale === null) ? undefined : this._priceScale;

		const addViewsForSources = (sources: ReadonlyArray<IDataSource>) => {
			for (let i = 0; i < sources.length; ++i) {
				const source = sources[i];
				const views = source.priceAxisViews(this._pane.state(), priceScale);
				for (let j = 0; j < views.length; j++) {
					res.push(views[j]);
				}
			}
		};

		// calculate max and min coordinates for views on selection
		// crosshair individually
		addViewsForSources(this._pane.state().orderedSources());

		return res;
	}

	private _drawBackground(ctx: CanvasRenderingContext2D): void {
		if (this._size === null) {
			return;
		}
		clearRect(ctx, 0, 0, this._size.w, this._size.h, this.backgroundColor());
	}

	private _drawBorder(ctx: CanvasRenderingContext2D): void {
		if (this._size === null || this._priceScale === null || !this._priceScale.options().borderVisible) {
			return;
		}
		ctx.save();
		ctx.fillStyle = this.lineColor();

		const borderSize = this.rendererOptions().borderSize;

		let left;
		if (this._isLeft) {
			ctx.translate(-0.5, -0.5);
			left = this._size.w - borderSize - 1;
		} else {
			ctx.translate(0.5, -0.5);
			left = 0;
		}

		ctx.fillRect(left, 0, borderSize, this._size.h);
		ctx.restore();
	}

	private _drawTickMarks(ctx: CanvasRenderingContext2D): void {
		if (this._size === null || this._priceScale === null) {
			return;
		}
		ctx.save();
		ctx.strokeStyle = this.lineColor();

		const tickMarks = this._priceScale.marks();
		ctx.font = this.baseFont();
		ctx.translate(-0.5, -0.5);
		ctx.fillStyle = this.lineColor();
		const rendererOptions = this.rendererOptions();
		const drawTicks = this._priceScale.options().borderVisible;

		const tickMarkLeftX = this._isLeft ?
			this._size.w - rendererOptions.offsetSize - rendererOptions.borderSize - rendererOptions.tickLength :
			rendererOptions.borderSize + rendererOptions.offsetSize;

		const textLeftX = this._isLeft ?
			tickMarkLeftX - rendererOptions.paddingInner :
			tickMarkLeftX + rendererOptions.tickLength + rendererOptions.paddingInner;

		const textAlign = this._isLeft ? 'right' : 'left';

		if (drawTicks) {
			ctx.beginPath();
			for (const tickMark of tickMarks) {
				ctx.rect(tickMarkLeftX, tickMark.coord, rendererOptions.tickLength, 1);
			}

			ctx.fill();
		}

		ctx.fillStyle = this.textColor();
		for (const tickMark of tickMarks) {
			this._tickMarksCache.paintTo(ctx, tickMark.label, textLeftX, tickMark.coord, textAlign);
		}

		ctx.restore();
	}

	private _alignLabels(): void {
		if (this._size === null || this._priceScale === null) {
			return;
		}
		let center = this._size.h / 2;

		const views: IPriceAxisView[] = [];
		const orderedSources = this._priceScale.orderedSources().slice(); // Copy of array
		const pane = this._pane;
		const paneState = pane.state();
		const rendererOptions = this.rendererOptions();

		// if we are default price scale, append labels from no-scale
		const isDefault = this._priceScale === paneState.defaultPriceScale();

		if (isDefault) {
			this._pane.state().orderedSources().forEach((source: IDataSource) => {
				if (paneState.isOverlay(source)) {
					orderedSources.push(source);
				}
			});
		}

		const mainSource = this._priceScale.mainSource();
		const priceScale = this._priceScale;

		const updateForSources = (sources: IDataSource[]) => {
			sources.forEach((source: IDataSource) => {
				const sourceViews = source.priceAxisViews(paneState, priceScale);
				// never align selected sources
				sourceViews.forEach((view: IPriceAxisView) => {
					view.setFixedCoordinate(null);
					if (view.isVisible()) {
						views.push(view);
					}
				});
				if (mainSource === source && sourceViews.length > 0) {
					center = sourceViews[0].floatCoordinate();
				}
			});
		};

		// crosshair individually
		updateForSources(orderedSources);

		// split into two parts
		const top = views.filter((view: IPriceAxisView) => view.floatCoordinate() <= center);
		const bottom = views.filter((view: IPriceAxisView) => view.floatCoordinate() > center);

		// sort top from center to top
		top.sort((l: IPriceAxisView, r: IPriceAxisView) => r.floatCoordinate() - l.floatCoordinate());

		// share center label
		if (top.length && bottom.length) {
			bottom.push(top[0]);
		}

		bottom.sort((l: IPriceAxisView, r: IPriceAxisView) => l.floatCoordinate() - r.floatCoordinate());

		views.forEach((view: IPriceAxisView) => view.setFixedCoordinate(view.coordinate()));

		const options = this._priceScale.options();
		if (!options.alignLabels) {
			return;
		}

		for (let i = 1; i < top.length; i++) {
			const view = top[i];
			const prev = top[i - 1];
			const height = prev.height(rendererOptions, false);
			const coordinate = view.coordinate();
			const prevFixedCoordinate = prev.getFixedCoordinate();

			if (coordinate > prevFixedCoordinate - height) {
				view.setFixedCoordinate(prevFixedCoordinate - height);
			}
		}

		for (let j = 1; j < bottom.length; j++) {
			const view = bottom[j];
			const prev = bottom[j - 1];
			const height = prev.height(rendererOptions, true);
			const coordinate = view.coordinate();
			const prevFixedCoordinate = prev.getFixedCoordinate();

			if (coordinate < prevFixedCoordinate + height) {
				view.setFixedCoordinate(prevFixedCoordinate + height);
			}
		}
	}

	private _drawBackLabels(ctx: CanvasRenderingContext2D): void {
		if (this._size === null) {
			return;
		}

		const size = this._size;
		const views = this._backLabels();

		const rendererOptions = this.rendererOptions();
		const align = this._isLeft ? 'right' : 'left';

		views.forEach((view: IPriceAxisView) => {
			if (view.isAxisLabelVisible()) {
				const renderer = view.renderer();
				ctx.save();
				renderer.draw(ctx, rendererOptions, this._widthCache, size.w, align);
				ctx.restore();
			}
		});
	}

	private _drawCrosshairLabel(ctx: CanvasRenderingContext2D): void {
		if (this._size === null || this._priceScale === null) {
			return;
		}

		const size = this._size;
		const model = this._pane.chart().model();

		const views: IPriceAxisViewArray[] = []; // array of arrays
		const pane = this._pane.state();

		const v = model.crosshairSource().priceAxisViews(pane, this._priceScale);
		if (v.length) {
			views.push(v);
		}

		const ro = this.rendererOptions();
		const align = this._isLeft ? 'right' : 'left';

		views.forEach((arr: IPriceAxisViewArray) => {
			arr.forEach((view: IPriceAxisView) => {
				ctx.save();
				view.renderer().draw(ctx, ro, this._widthCache, size.w, align);
				ctx.restore();
			});
		});
	}

	private _setCursor(type: CursorType): void {
		this._cell.style.cursor = type === CursorType.NsResize ? 'ns-resize' : 'default';
	}

	private _onMarksChanged(): void {
		const width = this.optimalWidth();

		if (this._prevOptimalWidth < width) {
			// avoid price scale is shrunk
			// using < instead !== to avoid infinite changes

			const chart = this._pane.chart();

			if (this._updateTimeout === null) {
				this._updateTimeout = setTimeout(
					() => {
						if (chart) {
							chart.model().fullUpdate();
						}
						this._updateTimeout = null;
					},
					100);
			}
		}

		this._prevOptimalWidth = width;
	}

	private _recreateTickMarksCache(options: PriceAxisViewRendererOptions): void {
		this._tickMarksCache.destroy();

		this._tickMarksCache = new LabelsImageCache(
			options.fontSize,
			options.color,
			options.fontFamily
		);
	}
}
