import React from "react";
import Button from "@material-ui/core/Button";
import Dialog from "@material-ui/core/Dialog";
import DialogActions from "@material-ui/core/DialogActions";
import DialogContent from "@material-ui/core/DialogContent";
import DialogTitle from "@material-ui/core/DialogTitle";
import Typography from "@material-ui/core/Typography";

import { i18n } from "../../translate/i18n";

const InformationModal = ({ title, children, open, onClose }) => {
  return (
    <Dialog open={open} onClose={() => onClose(false)} aria-labelledby="information-dialog">
      <DialogTitle id="information-dialog">{title}</DialogTitle>
      <DialogContent dividers>
        <Typography>{children}</Typography>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={() => onClose(false)} color="primary">
          {i18n.t("Fechar")}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default InformationModal;

