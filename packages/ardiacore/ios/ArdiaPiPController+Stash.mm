#import "ArdiaPictureInPictureInternal.h"
#import "ArdiaPiPThrowMath.h"

#import <QuartzCore/QuartzCore.h>

using namespace ardia_pip;

@implementation ArdiaPiPController (Stash)

- (ArdiaPiPEdge)edgeFlungTowards:(NSPoint)velocity {
  const NSRect frame = _window.frame;
  const NSRect visible = [self homeScreen].visibleFrame;
  const auto side = ardia_pip_throw::FlungOffSide(ThrowRect(frame), {velocity.x, velocity.y}, ThrowRect(visible),
                                                   [self displayBeyond:ArdiaPiPEdgeLeft], [self displayBeyond:ArdiaPiPEdgeRight]);
  return side == ardia_pip_throw::kFlungRight ? ArdiaPiPEdgeRight : side == ardia_pip_throw::kFlungLeft ? ArdiaPiPEdgeLeft : ArdiaPiPEdgeNone;
}

- (ArdiaPiPEdge)landWithVelocity:(NSPoint)velocity flings:(BOOL)flings thrown:(BOOL *)thrown {
  [NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(settle) object:nil];
  _sawDrag = NO;
  *thrown = NO;
  if (_stashedEdge != ArdiaPiPEdgeNone && _stashScreen && [self homeScreen] != _stashScreen) [self setStashedEdge:ArdiaPiPEdgeNone];
  if (_stashedEdge != ArdiaPiPEdgeNone) {
    const ArdiaPiPEdge side = _stashedEdge;
    const NSRect frame = _window.frame, visible = [self gestureHome].visibleFrame;
    const CGFloat shown = side == ArdiaPiPEdgeRight ? NSMaxX(visible) - NSMinX(frame) : NSMaxX(frame) - NSMinX(visible);
    if (shown < NSWidth(frame) - 0.5) {
      const CGFloat inward = side == ArdiaPiPEdgeRight ? -velocity.x : velocity.x;
      const BOOL sideways = flings && fabs(velocity.x) > fabs(velocity.y);
      const BOOL open = sideways ? inward > 0 : shown > NSWidth(frame) * kOpenShare;
      const NSPoint carried = flings ? velocity : NSZeroPoint;
      if (open) [self unstashWithVelocity:carried];
      else [self stashAt:side velocity:carried];
      return open ? ArdiaPiPEdgeNone : side;
    }
  }
  ArdiaPiPEdge edge = [self edgeBeyond];
  if (edge == ArdiaPiPEdgeNone && flings && (edge = [self edgeFlungTowards:velocity]) != ArdiaPiPEdgeNone) _flungStashCount++;
  if (edge != ArdiaPiPEdgeNone) {
    [self stashAt:edge velocity:flings ? velocity : NSZeroPoint];
    return edge;
  }
  if (_stashedEdge != ArdiaPiPEdgeNone) [self setStashedEdge:ArdiaPiPEdgeNone];
  *thrown = flings && [self throwWithVelocity:velocity];
  if (!*thrown) [self rescueIfLost];
  return ArdiaPiPEdgeNone;
}

- (NSRect)frameStashedAt:(ArdiaPiPEdge)edge {
  NSRect frame = _window.frame;
  NSRect visible = [self homeScreen].visibleFrame;
  frame.origin.x = edge == ArdiaPiPEdgeRight ? NSMaxX(visible) - kPeek : NSMinX(visible) - NSWidth(frame) + kPeek;
  frame.origin.y = MIN(MAX(NSMinY(frame), NSMinY(visible)), NSMaxY(visible) - NSHeight(frame));
  return frame;
}

- (void)stashAt:(ArdiaPiPEdge)edge {
  [self stashAt:edge velocity:NSZeroPoint];
}

- (void)stashAt:(ArdiaPiPEdge)edge velocity:(NSPoint)velocity {
  _stashScreen = [self homeScreen];
  const NSRect target = [self frameStashedAt:edge];
  [self setStashedEdge:edge];
  [self springTo:target velocity:velocity response:ardia_pip_throw::kSettleResponse record:nil];
}

- (void)unstash {
  [self unstashWithVelocity:NSZeroPoint];
}

- (void)unstashWithVelocity:(NSPoint)velocity {
  ArdiaPiPEdge edge = _stashedEdge;
  if (edge == ArdiaPiPEdgeNone) return;
  NSRect frame = _window.frame;
  NSRect visible = [self gestureHome].visibleFrame;
  frame.origin.x = edge == ArdiaPiPEdgeRight ? NSMaxX(visible) - NSWidth(frame) - kReturnMargin : NSMinX(visible) + kReturnMargin;
  frame.origin.y = MIN(MAX(NSMinY(frame), NSMinY(visible)), NSMaxY(visible) - NSHeight(frame));
  [self setStashedEdge:ArdiaPiPEdgeNone];
  [self springTo:frame velocity:velocity response:ardia_pip_throw::kSettleResponse record:nil];
}

- (void)setStashedEdge:(ArdiaPiPEdge)edge {
  const BOOL was = _stashedEdge != ArdiaPiPEdgeNone;
  if (!was && edge != ArdiaPiPEdgeNone) _stashCount++;
  _stashedEdge = edge;
  ArdiaPiPHandle *handle = _overlay.handle;
  if (edge != ArdiaPiPEdgeNone) {
    if (!was || handle.edge != edge) handle.alphaValue = 0;
    handle.edge = edge;
    handle.hidden = NO;
    _overlay.needsLayout = YES;
    [_overlay layoutSubtreeIfNeeded];
    return;
  }
  if (!was) return;
  [NSAnimationContext
      runAnimationGroup:^(NSAnimationContext *context) {
        context.duration = 0.1;
        context.timingFunction = [CAMediaTimingFunction functionWithControlPoints:0.23 :1 :0.32 :1];
        handle.animator.alphaValue = 0;
      }
      completionHandler:^{
        if (self->_stashedEdge == ArdiaPiPEdgeNone) handle.hidden = YES;
      }];
}

- (void)revealHandle {
  ArdiaPiPHandle *handle = _overlay.handle;
  if (_stashedEdge == ArdiaPiPEdgeNone || handle.alphaValue >= 1) return;
  [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
    context.duration = 0.12;
    context.timingFunction = [CAMediaTimingFunction functionWithControlPoints:0.23 :1 :0.32 :1];
    handle.animator.alphaValue = 1;
  }];
}

- (NSDictionary *)takeGestureCounts {
  NSDictionary *counts = @{
    @"throws" : @(_throwCount),
    @"stashes" : @(_stashCount),
    @"flungStashes" : @(_flungStashCount),
    @"caretClicks" : @(_caretClickCount),
    @"caretDrags" : @(_caretDragCount),
  };
  _throwCount = _stashCount = _flungStashCount = _caretClickCount = _caretDragCount = 0;
  return counts;
}

- (void)countCaretPress:(BOOL)dragged {
  if (dragged) _caretDragCount++;
  else _caretClickCount++;
}

@end
