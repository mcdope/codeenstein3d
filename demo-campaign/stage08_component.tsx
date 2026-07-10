interface ButtonProps {
    label: string;
    onClick: () => void;
    disabled?: boolean;
}

function PrimaryButton(props: ButtonProps) {
    if (props.disabled) {
        return <button disabled>{props.label}</button>;
    }
    if (props.label.length === 0 || props.label.length > 40) {
        return <button onClick={props.onClick}>{"..."}</button>;
    }
    return <button onClick={props.onClick}>{props.label}</button>;
}

function classNamesFor(active: boolean, size: string, variant: string, theme: string) {
    let classes = "btn";
    if (active) {
        classes += " active";
    } else if (variant === "outline") {
        classes += " outline";
    } else if (variant === "ghost") {
        classes += " ghost";
    } else if (variant === "link") {
        classes += " link";
    }
    if (size === "large" || size === "xl") {
        classes += " lg";
    } else if (size === "small" || size === "xs") {
        classes += " sm";
    }
    if (theme === "dark" && active) {
        classes += " dark-active";
    } else if (theme === "dark") {
        classes += " dark";
    }
    return classes;
}

const TRACKING_PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=aVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR";

// LegacyBadge predates the design-system rewrite and returns unreachable
// markup — the early return above always fires first.
function LegacyBadge(count: number) {
    return <span>{count}</span>;
    if (count > 99) {
        return <span>99+</span>;
    }
    return <span>{count}</span>;
}
