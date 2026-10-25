import { WindowBackdrop } from "@ardia/shaders";
import { ContextMenuArea, setTrafficLightsCenter, WindowDragRegion } from "@ardia/shell";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { profileTheme, useTheme } from "../../lib/theme";
import { useBrowser } from "../../store/browser";
import { useActiveTab, useWindowId, useWindowProfile, useWindowProfileId, useWindowUi } from "../../store/hooks";
import type { Tab } from "../../store/types";
import { CommandPanel } from "../CommandPanel";
import { ContentCard } from "../ContentCard";
import { DownloadsPopover } from "../Downloads";
import { WindowProfile } from "../layout/WindowProfile";
import { setUrlAnchor } from "../layout/windowLayout";
import { showUrlBarMenu } from "../omnibox/paste";
import { useHover } from "../primitives";
import { copyPageUrl } from "../site/selection";
import { ProfileBadge } from "../profiles/icons";
import { openInMainWindow, openLittleArdiaProfileMenu } from "./actions";
import { PageLabel, SMALL_BAR_HEIGHT, SMALL_INSET, SmallBar, SmallBarBadgeButton } from "./SmallChrome";

const LIGHTS_CENTER: [number, number] = [20, SMALL_BAR_HEIGHT / 2];
const FIELD_LEFT = 84;
const PROFILE_FADE_MS = 250;
const PROFILE_FADE_EASING = Easing.bezier(0.23, 1, 0.32, 1);

export function LittleArdiaWindow() {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  return (
    <View style={{ flex: 1 }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <WindowBackdrop vibrancy {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
      <WindowProfile />
      <LeavingProfileTint />
      <View style={{ flex: 1, flexDirection: "row", paddingTop: SMALL_BAR_HEIGHT, paddingLeft: SMALL_INSET, paddingRight: SMALL_INSET, paddingBottom: SMALL_INSET }}>
        <ContentCard />
      </View>
      <View style={{ position: "absolute", left: 0, right: 0, top: 0 }}>
        <LittleArdiaBar />
      </View>
      <CommandPanel windowWidth={width} />
      <DownloadsPopover />
    </View>
  );
}

function LeavingProfileTint() {
  const profileId = useWindowProfileId();
  const shown = useRef(profileId);
  const [leaving, setLeaving] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const theme = useBrowser((s) => (leaving ? profileTheme(s.profiles[leaving], s.ui.appDark) : null));

  useLayoutEffect(() => {
    const was = shown.current;
    shown.current = profileId;
    if (was === profileId) return;
    setLeaving(was);
    opacity.setValue(1);
    Animated.timing(opacity, { toValue: 0, duration: PROFILE_FADE_MS, easing: PROFILE_FADE_EASING, useNativeDriver: true }).start(
      ({ finished }) => finished && setLeaving(null),
    );
  }, [profileId, opacity]);

  if (!theme) return null;
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]}>
      <WindowBackdrop vibrancy {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
    </Animated.View>
  );
}

function LittleArdiaBar() {
  const windowId = useWindowId();
  const tab = useActiveTab();
  const panelOpen = useWindowUi().panel.open;
  const severalProfiles = useBrowser((s) => s.profileOrder.length > 1);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    void setTrafficLightsCenter(windowId, LIGHTS_CENTER);
  }, [windowId]);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const copy = () => {
    if (!tab?.url) return;
    void copyPageUrl(tab.id);
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1400);
  };

  return (
    <SmallBar
      fieldLeft={FIELD_LEFT}
      field={tab ? <PageField tab={tab} windowId={windowId} hidden={panelOpen} /> : null}
      buttons={[
        { icon: copied ? "checkmark" : "link", size: 14, disabled: !tab?.url, tooltip: "Copy Link (⇧⌘C)", onPress: copy },
        { icon: "arrow.up.left.and.arrow.down.right", size: 13, tooltip: "Open in Ardia (⌘O)", onPress: () => openInMainWindow(windowId) },
      ]}
      trailing={severalProfiles ? <ProfileButton windowId={windowId} /> : undefined}
    >
      <WindowDragRegion style={StyleSheet.absoluteFill} />
    </SmallBar>
  );
}

function ProfileButton({ windowId }: { windowId: string }) {
  const profile = useWindowProfile();
  return (
    <SmallBarBadgeButton tooltip={`Profile: ${profile.name}`} onPress={() => void openLittleArdiaProfileMenu(windowId)}>
      <ProfileBadge profile={profile} size={16} />
    </SmallBarBadgeButton>
  );
}

function PageField({ tab, windowId, hidden }: { tab: Tab; windowId: string; hidden: boolean }) {
  const { hovered, hoverProps } = useHover();
  const field = useRef<View>(null);
  const anchor = () =>
    field.current?.measureInWindow((x, y, width, height) => {
      if (width) setUrlAnchor(windowId, { left: x, top: y, width, sidebar: { height } });
    });

  return (
    <View ref={field} onLayout={anchor} {...hoverProps} style={{ flex: 1, opacity: hidden ? 0 : 1 }}>
      <ContextMenuArea style={{ flex: 1 }} onContextMenu={() => tab.url && void showUrlBarMenu(tab)}>
        <WindowDragRegion clickable onRegionClick={() => useBrowser.getState().openPanel(windowId, tab.url)} style={{ flex: 1 }}>
          <PageLabel tab={tab} hovered={hovered} />
        </WindowDragRegion>
      </ContextMenuArea>
    </View>
  );
}
