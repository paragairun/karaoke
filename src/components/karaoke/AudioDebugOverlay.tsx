import { Card } from "@/components/ui/card";

type Debug = {
  micActive: boolean;
  micError?: string | null;
  volume: number;
  voiceDetected: boolean;
  referenceActive?: boolean;
  voiceThreshold?: number;
  noiseFloor?: number;
  audioCtxState?: string;
  userVolumeRmsFloat?: number;
  userFreqEnergyDb?: number;
};

export function AudioDebugOverlay({ debug }: { debug: Debug }) {
  const fmt = (n: number | undefined) =>
    typeof n === "number" && Number.isFinite(n) ? n.toFixed(4) : "-";

  return (
    <div className="fixed bottom-3 right-3 z-50 w-[320px] max-w-[90vw]">
      <Card className="bg-card/90 backdrop-blur border-border p-3 text-foreground">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Audio Debug</p>
          <p className="text-xs text-muted-foreground">?debugAudio=1</p>
        </div>
        <div className="mt-2 space-y-1 text-xs">
          <div className="flex justify-between"><span className="text-muted-foreground">micActive</span><span>{String(debug.micActive)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">ctxState</span><span>{debug.audioCtxState ?? "-"}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">volume</span><span>{fmt(debug.volume)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">voiceDetected</span><span>{String(debug.voiceDetected)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">voiceThreshold</span><span>{fmt(debug.voiceThreshold)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">noiseFloor</span><span>{fmt(debug.noiseFloor)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">rmsFloat</span><span>{fmt(debug.userVolumeRmsFloat)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">freqDb</span><span>{fmt(debug.userFreqEnergyDb)}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">refActive</span><span>{String(!!debug.referenceActive)}</span></div>
          {debug.micError ? (
            <p className="mt-2 text-destructive">{debug.micError}</p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
