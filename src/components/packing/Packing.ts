import d3 from '../../utils/d3-import';
import type { Size, Padding, Point, Rect } from '../../types/common-types';
import type {
  PhraseTreeData,
  PhraseTextInfo,
  PhraseTextLineInfo
} from '../../types/packing-types';
import { timeit, round, yieldToMain, rectsIntersect } from '../../utils/utils';

import { getLatoTextWidth } from '../../utils/text-width';
import type { Writable } from 'svelte/store';
import type { TooltipStoreValue } from '../../stores';
import { getTooltipStoreDefaultValue } from '../../stores';
import { config } from '../../config/config';

const DEBUG = config.debug;
const FONT_SIZE = 12;
const HALO_WIDTH = 4;

/**
 * Class for the circle packing view
 */

export class Packer {
  svg: d3.Selection<HTMLElement, unknown, null, undefined>;
  /** The size of the BBox of the SVG element */
  svgFullSize: Size;
  /** The size of the drawing space of the SVG element */
  svgSize: Size;
  svgPadding: Padding;

  xScale: d3.ScaleLinear<number, number, never>;
  yScale: d3.ScaleLinear<number, number, never>;
  component: HTMLElement;
  updatePacker: () => void;

  // Circle packing
  pack: d3.HierarchyCircularNode<PhraseTreeData> | null = null;

  // Zooming
  focusNode: d3.HierarchyCircularNode<PhraseTreeData> | null = null;
  view: d3.ZoomView | null = null;
  baseView: d3.ZoomView | null = null;
  circleGroups: d3.Selection<
    SVGGElement,
    d3.HierarchyCircularNode<PhraseTreeData>,
    SVGGElement,
    unknown
  > | null = null;
  topTextGroups: d3.Selection<
    SVGGElement,
    d3.HierarchyCircularNode<PhraseTreeData>,
    SVGGElement,
    unknown
  > | null = null;

  // Stores
  tooltipStore: Writable<TooltipStoreValue>;
  tooltipStoreValue: TooltipStoreValue = getTooltipStoreDefaultValue();

  /**
   *
   * @param args Named parameters
   * @param args.component The component
   */
  constructor({
    component,
    tooltipStore,
    updatePacker
  }: {
    component: HTMLElement;
    tooltipStore: Writable<TooltipStoreValue>;
    updatePacker: () => void;
  }) {
    this.component = component;
    this.updatePacker = updatePacker;

    // Initialize the SVG
    this.svg = d3.select(this.component).select('svg.packing-svg');
    this.svgFullSize = { width: 0, height: 0 };
    const svgBBox = this.svg.node()?.getBoundingClientRect();
    if (svgBBox !== undefined) {
      this.svgFullSize.width = svgBBox.width;
      this.svgFullSize.height = svgBBox.height;
    }

    this.svgPadding = {
      top: 5,
      bottom: 5,
      left: 5,
      right: 5
    };
    this.svgSize = {
      width:
        this.svgFullSize.width - this.svgPadding.left - this.svgPadding.right,
      height:
        this.svgFullSize.width - this.svgPadding.top - this.svgPadding.bottom
    };

    // Initialize SVG layers
    const content = this.svg
      .append('g')
      .attr('class', 'content')
      .attr(
        'transform',
        `translate(${this.svgPadding.left}, ${this.svgPadding.top})`
      );
    content
      .append('rect')
      .attr('class', 'back-rect')
      .attr('width', this.svgSize.width)
      .attr('height', this.svgSize.height)
      .on('click', (e: MouseEvent) => {
        if (this.pack) {
          this.resetZoomInteractions();
          this.circleClickHandler(e, this.pack);
        }
      });

    // Subscribe the store
    this.tooltipStore = tooltipStore;
    this.tooltipStore.subscribe(value => {
      this.tooltipStoreValue = value;
    });

    // d3.pack() uses [0, 1] ranges by default
    this.xScale = d3
      .scaleLinear()
      .domain([0, 1])
      .range([0, this.svgSize.width]);

    this.yScale = d3
      .scaleLinear()
      .domain([0, 1])
      .range([this.svgSize.height, 0]);

    this.initData().then(() => {
      // Draw the circle packing after loading the data
      timeit('Draw circle packing', DEBUG);
      this.drawCirclePacking();
      timeit('Draw circle packing', DEBUG);
    });
  }

  /**
   * Load the data
   */
  initData = async () => {
    const jsonURL = `${import.meta.env.BASE_URL}data/phrases-tree.json`;
    const phraseData = (await d3.json(jsonURL)) as PhraseTreeData;

    const root = d3
      .hierarchy(phraseData, d => d.c)
      .sum(d => d.v)
      .sort((a, b) => b.data.v - a.data.v);

    this.pack = d3
      .pack<PhraseTreeData>()
      .padding(3)
      .size([this.svgSize.width, this.svgSize.height])(root);
  };

  /**
   * Draw the circle packing
   */
  drawCirclePacking = () => {
    if (this.pack === null) return;
    const content = this.svg.select('g.content');
    const circleContent = content.append('g').attr('class', 'content-circle');
    const textContent1 = content.append('g').attr('class', 'content-text-1');
    const textContent2 = content.append('g').attr('class', 'content-text-2');
    const textContent3 = content.append('g').attr('class', 'content-text-3');

    // Initialize the zoom
    this.focusNode = this.pack;
    this.view = [this.pack.x, this.pack.y, this.pack.r * 2];
    this.baseView = [this.pack.x, this.pack.y, this.pack.r * 2];

    const enterFunc = (
      enter: d3.Selection<
        d3.EnterElement,
        d3.HierarchyCircularNode<PhraseTreeData>,
        SVGGElement,
        unknown
      >
    ) => {
      // Draw the circle
      const group = enter
        .append('g')
        .attr('class', d => `circle-group circle-group-${d.depth}`)
        .attr('transform', d => `translate(${d.x}, ${d.y})`)
        .classed('no-pointer', d => d.r < 10 && d.children === undefined)
        .style('font-size', `${FONT_SIZE}px`);

      group
        .append('circle')
        .attr('class', 'phrase-circle')
        .attr('cx', 0)
        .attr('cy', 0)
        .attr('r', d => d.r)
        .on('mouseenter', (e, d) =>
          this.circleMouseenterHandler(e as MouseEvent, d)
        )
        .on('mouseleave', (e, d) =>
          this.circleMouseleaveHandler(e as MouseEvent, d)
        )
        .on('click', (e, d) => this.circleClickHandler(e as MouseEvent, d));

      // Draw the text
      group
        .append('text')
        .attr('class', d => `phrase-label phrase-label-${d.depth}`)
        .each((d, i, g) =>
          drawLabelInCircle({
            d,
            i,
            g,
            hideParent: true,
            checkHidden: true,
            showHalo: false,
            scale: 1,
            markVisible: true
          })
        );

      return group;
    };

    // Visible all children and compute the text size information
    const nodes = this.pack.descendants().slice(1);
    for (const node of nodes) {
      node.data.textInfo = processName(node.data.n);
    }
    this.circleGroups = circleContent
      .selectAll<SVGGElement, d3.HierarchyCircularNode<PhraseTreeData>>(
        'g.circle-group'
      )
      .data(nodes)
      .join(enterFunc);

    // Draw the text of first level circles on top of all circles
    // Find all first level nodes without any text drawn and have enough space
    // to show a text label
    const firstLevelNodes = nodes.filter(d => d.depth === 1);
    const topLabelNodes = [];
    for (const node of firstLevelNodes) {
      // Check if we have drawn label for this node or its descendants
      let hasDrawnLabel = false;
      for (const child of node.descendants()) {
        if (child.data.textInfo!.visible) {
          hasDrawnLabel = true;
          break;
        }
      }
      if (hasDrawnLabel) continue;

      // Check if the circle is large enough to hold the first-level label
      const minDiagonal = Math.min(
        node.data.textInfo!.infos[0].diagonal,
        node.data.textInfo!.infos[1].diagonal
      );
      if (minDiagonal < 2 * node.r) {
        topLabelNodes.push(node);
      }
    }

    this.topTextGroups = textContent1
      .selectAll<SVGGElement, d3.HierarchyCircularNode<PhraseTreeData>>(
        'g.top-text-group'
      )
      .data(topLabelNodes)
      .join('g')
      .attr('class', 'top-text-group')
      .attr('transform', d => `translate(${d.x - d.r}, ${d.y - d.r})`)
      .style('font-size', `${FONT_SIZE}px`);

    // Draw the text
    this.topTextGroups
      .append('text')
      .attr('class', 'phrase-label')
      .attr('transform', d => `translate(${d.r}, ${d.r})`)
      .each((d, i, g) =>
        drawLabelInCircle({
          d,
          i,
          g,
          hideParent: false,
          checkHidden: true,
          showHalo: true,
          scale: 1,
          markVisible: false
        })
      );

    this.zoomToView(this.view);
  };

  /**
   * Mouse enter handler
   * @param e Mouse event
   * @param d Datum
   */
  circleMouseenterHandler = (
    e: MouseEvent,
    d: d3.HierarchyCircularNode<PhraseTreeData>
  ) => {
    const element = d3.select(e.target as HTMLElement);
    element.classed('hovered', true);
  };

  /**
   * Mouse leave handler
   * @param e Mouse event
   * @param d Datum
   */
  circleMouseleaveHandler = (
    e: MouseEvent,
    d: d3.HierarchyCircularNode<PhraseTreeData>
  ) => {
    const element = d3.select(e.target as HTMLElement);
    element.classed('hovered', false);
  };

  /**
   * Apply zoom at one frame
   * @param view [center x, center y, view width]
   */
  zoomToView = (view: d3.ZoomView) => {
    this.view = view;

    const scale = this.svgSize.width / view[2];
    const x0 = view[0] - view[2] / 2;
    const y0 = view[1] - view[2] / 2;

    this.circleGroups
      ?.attr(
        'transform',
        d => `translate(${(d.x - x0) * scale},${(d.y - y0) * scale})`
      )
      .style('font-size', `${FONT_SIZE * scale}px`)
      .select('.phrase-circle')
      .attr('r', d => d.r * scale);
  };

  /**
   * Mouse leave handler
   * @param e Mouse event
   * @param d Datum
   */
  circleClickHandler = (
    e: MouseEvent,
    d: d3.HierarchyCircularNode<PhraseTreeData>
  ) => {
    if (this.focusNode === null || this.view === null) return;
    if (d === this.focusNode) return;
    e.stopPropagation();

    const textContent1 = this.svg.select<SVGGElement>('g.content-text-1');

    // Start zooming
    const previousFocusNode = this.focusNode;
    this.focusNode = d;
    const x0 = this.focusNode!.x - this.focusNode!.r;
    const y0 = this.focusNode!.y - this.focusNode!.r;
    const scale = this.svgSize.width / (this.focusNode!.r * 2);

    const trans = this.svg
      .transition('zoom')
      .duration(800)
      .tween('zoom', () => {
        const interpolate = d3.interpolateZoom(this.view!, [
          this.focusNode!.x,
          this.focusNode!.y,
          this.focusNode!.r * 2
        ]);

        return (t: number) => this.zoomToView(interpolate(t));
      }) as unknown as d3.Transition<d3.BaseType, unknown, null, undefined>;

    if (this.focusNode !== this.pack) {
      if (!this.circleGroups) return;

      textContent1
        .transition('label-removal')
        .duration(150)
        .style('opacity', 0);

      const lastTextContent = this.svg.select<SVGGElement>(
        `g.content-text-${previousFocusNode.depth + 1}`
      );
      const curTextContent = this.svg.select<SVGGElement>(
        `g.content-text-${this.focusNode.depth + 1}`
      );

      lastTextContent
        .transition('label-removal')
        .duration(150)
        .style('opacity', 0);

      curTextContent.style('opacity', 0).selectAll('*').remove();

      // Allow users to interact with all descendants
      this.circleGroups
        .filter(d => d.parent === this.focusNode)
        .style('--base-stroke', `${scale}px`)
        .classed('no-pointer', false);

      // If a node is focused, show all descendants' texts
      const topLabelNodes: d3.HierarchyCircularNode<PhraseTreeData>[] = [];
      const drawnRects: Rect[] = [];

      // Check if we have drawn label for this node or its descendants
      const descendants = d3.shuffle(this.focusNode.descendants().slice(1));
      for (const child of descendants) {
        if (!child.data.textInfo!.visible) {
          const curRect: Rect = {
            x: (child.x - x0) * scale - child.data.textInfo!.infos[1].width / 2,
            y:
              (child.y - y0) * scale - child.data.textInfo!.infos[1].height / 2,
            width: child.data.textInfo!.infos[1].width,
            height: child.data.textInfo!.infos[1].height
          };

          // Check if this label is taller than the back circle
          if (curRect.height > child.r * scale * 2 - 5) {
            continue;
          }

          // Check if this label would interact with other labels
          let intersect = false;
          for (const drawnRect of drawnRects) {
            if (rectsIntersect(drawnRect, curRect)) {
              intersect = true;
              break;
            }
          }

          if (!intersect) {
            topLabelNodes.push(child);
            drawnRects.push(curRect);
          }
        }
      }

      const localLabels = curTextContent
        .selectAll<SVGGElement, d3.HierarchyCircularNode<PhraseTreeData>>(
          'g.top-text-group'
        )
        .data(topLabelNodes)
        .join('g')
        .attr('class', 'top-text-group')
        .attr(
          'transform',
          d => `translate(${(d.x - x0) * scale}, ${(d.y - y0) * scale})`
        )
        .style('font-size', `${FONT_SIZE}px`);

      // Draw the text
      localLabels
        .append('text')
        .attr('class', 'phrase-label')
        .each((d, i, g) =>
          drawLabelInCircle({
            d,
            i,
            g,
            hideParent: false,
            checkHidden: false,
            showHalo: true,
            scale,
            markVisible: false
          })
        );

      trans.on('end', () => {
        curTextContent
          .transition('show-top-label')
          .duration(200)
          .style('opacity', 1);
      });
    } else {
      const lastTextContent = this.svg.select<SVGGElement>(
        `g.content-text-${previousFocusNode.depth + 1}`
      );
      lastTextContent
        .transition('label-removal')
        .duration(150)
        .style('opacity', 0)
        .on('end', () => {
          lastTextContent.selectAll('*').remove();
        });

      trans.on('end', () => {
        textContent1.transition('label-show').duration(150).style('opacity', 1);
      });
    }
  };

  /**
   * Reset all zoom-related configurations for drawn elements
   */
  resetZoomInteractions = () => {
    if (this.circleGroups === null) return;
    // Reset stroke base values
    this.circleGroups
      .style('--base-stroke', '1px')
      .classed('no-pointer', d => d.r < 10 && d.children === undefined)
      .style('font-size', `${FONT_SIZE}px`);
  };
}

/**
 * Get the size info about a phrase text
 * @param name The phrase text
 * @returns Size info about this text
 */
const processName = (name: string) => {
  const words = name.split(' ');
  const lineInfo1: PhraseTextLineInfo = {
    width: getLatoTextWidth(name, FONT_SIZE),
    height: FONT_SIZE,
    diagonal: Math.sqrt(
      getLatoTextWidth(name, FONT_SIZE) ** 2 + FONT_SIZE ** 2
    ),
    lines: [name]
  };

  const lineInfo2: PhraseTextLineInfo = {
    width: 0,
    height: 0,
    diagonal: 0,
    lines: [name]
  };

  if (words.length == 1) {
    lineInfo2.width = getLatoTextWidth(name, FONT_SIZE);
    lineInfo2.height = FONT_SIZE;
  } else {
    // Split the name into two lines with the same number of words
    const line1 = words.slice(0, Math.floor(words.length / 2)).join(' ');
    const line2 = words.slice(Math.floor(words.length / 2)).join(' ');

    lineInfo2.lines = [line1, line2];
    lineInfo2.width = Math.max(
      getLatoTextWidth(line1, FONT_SIZE),
      getLatoTextWidth(line2, FONT_SIZE)
    );
    lineInfo2.height = FONT_SIZE * 2;
  }

  lineInfo2.diagonal = Math.sqrt(lineInfo2.width ** 2 + lineInfo2.height ** 2);

  const result: PhraseTextInfo = {
    visible: false,
    infos: [lineInfo1, lineInfo2]
  };

  return result;
};

/**
 * Return true if the circle should not display its text
 * @param d Node data
 * @param hideParent True if hide text of nodes with children nodes
 * @param scale Current zoom scale for the circle's radius
 * @returns True if the circle should not display its text
 */
const shouldHideText = (
  d: d3.HierarchyCircularNode<PhraseTreeData>,
  hideParent: boolean,
  scale: number
) => {
  if (hideParent && d.children !== undefined) return true;

  return d.data.textInfo
    ? Math.min(
        d.data.textInfo.infos[0].diagonal,
        d.data.textInfo.infos[1].diagonal
      ) >
        2 * d.r * scale
    : true;
};

const drawLabelInCircle = ({
  d,
  i,
  g,
  hideParent,
  checkHidden,
  showHalo,
  scale,
  markVisible
}: {
  d: d3.HierarchyCircularNode<PhraseTreeData>;
  i: number;
  g: SVGTextElement[] | ArrayLike<SVGTextElement>;
  hideParent: boolean;
  checkHidden: boolean;
  showHalo: boolean;
  scale: number;
  markVisible: boolean;
}) => {
  if (d.data.textInfo === undefined) return;
  if (checkHidden && shouldHideText(d, hideParent, scale)) return;

  if (markVisible) d.data.textInfo.visible = true;
  const element = d3.select(g[i]);

  // Prioritize fitting the text in one line
  if (
    d.data.textInfo.infos[0].diagonal < 2 * d.r ||
    (!checkHidden && d.data.textInfo.infos[1].lines.length == 1)
  ) {
    // One line
    const line = element
      .append('tspan')
      .attr('class', 'line-1')
      .attr('x', 0)
      .attr('y', 0)
      .text(d.data.textInfo.infos[0].lines[0]);

    if (showHalo) {
      line
        .attr('paint-order', 'stroke')
        .attr('stroke', 'white')
        .attr('stroke-width', HALO_WIDTH);
    }
  } else {
    // Two lines
    const line1 = element
      .append('tspan')
      .attr('class', 'line-1')
      .attr('x', 0)
      .attr('y', 0)
      .attr('dy', '-0.5em')
      .text(d.data.textInfo.infos[1].lines[0]);

    const line2 = element
      .append('tspan')
      .attr('class', 'line-2')
      .attr('x', 0)
      .attr('y', 0)
      .attr('dy', '0.5em')
      .text(d.data.textInfo.infos[1].lines[1]!);

    if (showHalo) {
      for (const line of [line1, line2]) {
        line
          .attr('paint-order', 'stroke')
          .attr('stroke', 'white')
          .attr('stroke-width', HALO_WIDTH);
      }
    }
  }
};