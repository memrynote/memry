//! Back and forward from the trackpad and the Windows browser keys
//! (`apps/desktop/src/main/app-navigation-command.ts`).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavDirection {
    Back,
    Forward,
}

impl NavDirection {
    pub fn name(self) -> &'static str {
        match self {
            Self::Back => "back",
            Self::Forward => "forward",
        }
    }
}

/// A macOS swipe event's `deltaX`: positive is a swipe to the right, which goes back.
pub fn swipe_direction(delta_x: f64) -> Option<NavDirection> {
    if delta_x > 0.0 {
        Some(NavDirection::Back)
    } else if delta_x < 0.0 {
        Some(NavDirection::Forward)
    } else {
        None
    }
}

/// `APPCOMMAND_BROWSER_BACKWARD` (1) and `APPCOMMAND_BROWSER_FORWARD` (2) of `WM_APPCOMMAND`.
pub fn app_command_direction(command: i32) -> Option<NavDirection> {
    match command {
        1 => Some(NavDirection::Back),
        2 => Some(NavDirection::Forward),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swipes_map_to_directions() {
        assert_eq!(swipe_direction(1.0), Some(NavDirection::Back));
        assert_eq!(swipe_direction(-0.5), Some(NavDirection::Forward));
        assert_eq!(swipe_direction(0.0), None);
        assert_eq!(swipe_direction(f64::NAN), None);
    }

    #[test]
    fn app_commands_map_to_directions() {
        assert_eq!(app_command_direction(1), Some(NavDirection::Back));
        assert_eq!(app_command_direction(2), Some(NavDirection::Forward));
        assert_eq!(app_command_direction(7), None);
    }
}
