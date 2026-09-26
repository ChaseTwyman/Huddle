import type { CSSProperties } from 'react';

export const initials = (name: string) => name.trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';

export function Avatar(props: { name: string; color: string; locked?: boolean; off?: boolean; bounce?: boolean; floatText?: string | null; title?: string }) {
  const cls = ['avatar', props.locked && 'locked', props.off && 'off', props.bounce && 'bounce'].filter(Boolean).join(' ');
  return (
    <div className={cls} style={{ '--c': props.color } as CSSProperties} title={props.title ?? props.name}>
      {initials(props.name)}
      {props.floatText ? <span className="float-pts">{props.floatText}</span> : null}
    </div>
  );
}
