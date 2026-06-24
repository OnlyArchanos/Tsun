'use client';

import { useEffect, useRef } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';

export default function PriceChart({ data = [], color = '#5865f2' }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: '#9898b0',
        fontFamily: "'Inter', sans-serif",
        fontSize: 12,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.03)' },
        horzLines: { color: 'rgba(255,255,255,0.03)' },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: 'rgba(88,101,242,0.3)', width: 1, style: 2 },
        horzLine: { color: 'rgba(88,101,242,0.3)', width: 1, style: 2 },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.06)',
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.06)',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: { vertTouchDrag: false },
    });

    const series = chart.addSeries(AreaSeries, {
      lineColor: color,
      lineWidth: 2,
      topColor: color + '40',
      bottomColor: color + '05',
      crosshairMarkerBackgroundColor: color,
      crosshairMarkerRadius: 4,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    if (data.length > 0) {
      series.setData(data);
      chart.timeScale().fitContent();
    }

    chartRef.current = { chart, series };

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Update data when it changes without recreating the chart
  useEffect(() => {
    if (chartRef.current && data.length > 0) {
      chartRef.current.series.setData(data);
      chartRef.current.chart.timeScale().fitContent();
    }
  }, [data]);

  // Update color when it changes
  useEffect(() => {
    if (chartRef.current) {
      chartRef.current.series.applyOptions({
        lineColor: color,
        topColor: color + '40',
        bottomColor: color + '05',
        crosshairMarkerBackgroundColor: color,
      });
    }
  }, [color]);

  return (
    <div className="chart-container">
      <div ref={containerRef} className="chart-inner" />
    </div>
  );
}
