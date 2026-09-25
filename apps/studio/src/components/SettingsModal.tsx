import { Eye, EyeOff, KeyRound, Lock, ShieldCheck, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogSection,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ToggleRow } from "@/components/ui/switch";
import { getShellVersion, isTauri } from "@/lib/tauri";
import { resolveMode, useStudioStore } from "@/store/useStudioStore";

/** Settings modal for the local environment keys and mode overrides. */
export function SettingsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const credentials = useStudioStore((state) => state.credentials);
  const forceDemo = useStudioStore((state) => state.forceDemo);
  const setCredentials = useStudioStore((state) => state.setCredentials);
  const clearCredentials = useStudioStore((state) => state.clearCredentials);
  const setForceDemo = useStudioStore((state) => state.setForceDemo);
  const [shellVersion, setShellVersion] = useState<string | null>(null);
  const [desktop, setDesktop] = useState(false);

  useEffect(() => {
    setDesktop(isTauri());
    void getShellVersion().then(setShellVersion);
  }, []);

  const mode = resolveMode(credentials, forceDemo);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Environment & credentials"
        description="Keys are stored in this application's local storage on your machine. Use the Tauri store or Stronghold plugin to move them into the OS keychain before shipping this to other users."
      >
        <div className="flex flex-col gap-4">
          <DialogSection title="Routing">
            <div className="flex items-center gap-2">
              <Badge tone={mode === "live" ? "accent" : "neutral"}>
                {mode === "live" ? "Live API" : "Demo mode"}
              </Badge>
              {desktop ? (
                <Badge tone="info" className="gap-1">
                  <ShieldCheck className="h-3 w-3" />
                  Desktop shell{shellVersion ? ` v${shellVersion}` : ""}
                </Badge>
              ) : (
                <Badge tone="neutral" className="gap-1">
                  <WifiOff className="h-3 w-3" />
                  Browser preview
                </Badge>
              )}
            </div>
            <ToggleRow
              checked={forceDemo}
              onCheckedChange={setForceDemo}
              label="Force demo mode"
              hint="Simulate Jev and Gemini locally. No network calls, no key required."
            />
          </DialogSection>

          <DialogSection title="TypeSafe AI (Jev)">
            <SecretField
              label="TYPESAFE_API_KEY"
              value={credentials.typesafeApiKey}
              onChange={(value) => setCredentials({ typesafeApiKey: value })}
              placeholder="ts_live_…"
              hint="Required for live decision routing to POST /v1/systemone."
            />
          </DialogSection>

          <DialogSection title="Google Gemini">
            <SecretField
              label="GEMINI_API_KEY"
              value={credentials.geminiApiKey}
              onChange={(value) => setCredentials({ geminiApiKey: value })}
              placeholder="AIza…"
              hint="Optional. Without it, a low-confidence run degrades to human escalation with template prose instead of cascading to gemini-2.5-flash."
            />
          </DialogSection>

          <div className="flex items-center gap-2 border-t border-edge pt-4">
            <Lock className="h-3.5 w-3.5 text-slate-500" />
            <span className="text-[11px] text-slate-500">
              Keys never leave this machine except as an Authorization header to
              the provider you configured.
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                size="sm"
                variant="danger"
                onClick={clearCredentials}
                disabled={!credentials.typesafeApiKey && !credentials.geminiApiKey}
              >
                Clear keys
              </Button>
              <DialogClose asChild>
                <Button size="sm" variant="default">
                  Done
                </Button>
              </DialogClose>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SecretField({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">
        <KeyRound className="h-3 w-3" />
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        <Input
          type={revealed ? "text" : "password"}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          size="iconSm"
          variant="ghost"
          onClick={() => setRevealed((current) => !current)}
          title={revealed ? "Hide value" : "Reveal value"}
        >
          {revealed ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
      {hint ? (
        <span className="text-[11px] leading-snug text-slate-600">{hint}</span>
      ) : null}
    </div>
  );
}
