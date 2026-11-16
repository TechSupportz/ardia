import AppKit

extension PeekStage {
  private var mapsInput: Bool {
    let f = lastFrame
    guard !motion.geometry.fullscreen, !f.warping, motion.phase != .waiting, motion.phase != .idle else { return false }
    return abs(f.page.s - 1) > 1e-6 || abs(f.page.tx) > 1e-6 || abs(f.page.ty) > 1e-6
  }

  override func hitTest(_ point: NSPoint) -> NSView? {
    guard !isHidden, alphaValue > 0, let parent = superview else { return nil }
    let p = convert(point, from: parent)
    guard bounds.contains(p) else { return nil }
    if motion.phase == .finished { return nil }
    if lastFrame.warping || motion.warpingEntrance {
      return shownCard.contains(p) ? self : scrim.hitTest(p)
    }
    if motion.phase == .waiting { return shownCard.contains(p) ? self : scrim.hitTest(p) }
    if PeekInputRoute.matches(self, windowPoint: convert(p, to: nil)) { return page.hitTest(p) ?? self }
    if !mapsInput { return super.hitTest(point) }
    if lastFrame.shownPage.contains(p) { return page.hitTest(lastFrame.page.inverse.apply(p)) ?? self }
    if shownCard.contains(p) { return chrome.hitTest(lastFrame.card.inverse.apply(p)) ?? self }
    return scrim.hitTest(p)
  }

  func remap(_ event: NSEvent, at windowPoint: NSPoint) -> NSEvent? {
    guard let window, mapsInput else { return nil }
    let p = convert(windowPoint, from: nil)
    switch event.type {
    case .leftMouseDown, .rightMouseDown, .otherMouseDown:
      pressInPage = lastFrame.shownPage.contains(p) && owns(windowPoint, in: window)
      guard pressInPage else { return nil }
    case .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .leftMouseUp, .rightMouseUp, .otherMouseUp:
      guard pressInPage else { return nil }
      if event.type == .leftMouseUp || event.type == .rightMouseUp || event.type == .otherMouseUp { pressInPage = false }
    default:
      guard lastFrame.shownPage.contains(p), owns(windowPoint, in: window) else { return nil }
    }
    let target = convert(lastFrame.page.inverse.apply(p), to: nil)
    guard let mapped = PeekInputRoute.moved(event, to: target, in: window) else { return nil }
    PeekInputRoute.routed = PeekInputRoute.Routed(stage: self, point: target, timestamp: event.timestamp)
    return mapped
  }

  private func owns(_ windowPoint: NSPoint, in window: NSWindow) -> Bool {
    guard let root = window.contentView?.superview, let hit = root.hitTest(windowPoint) else { return false }
    return hit === self || hit.isDescendant(of: self)
  }
}
