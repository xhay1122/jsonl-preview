import Button from 'tdesign-react/es/button';
import Tooltip from 'tdesign-react/es/tooltip';
import type { MouseEvent, ReactElement } from 'react';

export function IconAction({ label, tooltip = label, icon, onClick, primary = false }: {
  label: string;
  tooltip?: string;
  icon: ReactElement;
  onClick(event: MouseEvent<HTMLElement>): void;
  primary?: boolean;
}) {
  return <Tooltip placement="bottom" delay={0} overlayClassName="icon-action-tooltip"
    content={<span role="tooltip">{tooltip}</span>}>
    <Button size="small" shape="square" theme={primary ? 'primary' : 'default'} variant={primary ? 'base' : 'outline'}
      icon={icon} aria-label={label} onClick={onClick} />
  </Tooltip>;
}
